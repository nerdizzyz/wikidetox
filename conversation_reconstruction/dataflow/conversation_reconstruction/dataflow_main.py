# -*- coding: utf-8 -*-
"""
Copyright 2017 Google Inc.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

-------------------------------------------------------------------------------

A dataflow pipeline to reconstruct conversations on Wikipedia talk pages from ingested json files.

Run with:

reconstruct*.sh in helper_shell

"""
from __future__ import absolute_import
import argparse
import logging
import subprocess
import json
from os import path
import urllib2
import traceback
import ast
import copy
import sys

import apache_beam as beam
from apache_beam.options.pipeline_options import PipelineOptions
from apache_beam.options.pipeline_options import SetupOptions
from construct_utils.conversation_constructor import Conversation_Constructor


LOG_INTERVAL = 100

def run(known_args, pipeline_args):
  """Main entry point; defines and runs the reconstruction pipeline."""

  pipeline_args.extend([
    '--runner=DataflowRunner',
    '--project=wikidetox-viz',
    '--staging_location=gs://wikidetox-viz-dataflow/staging',
    '--temp_location=gs://wikidetox-viz-dataflow/tmp',
    '--job_name=reconstruction-from-{table}-week{lw}year{ly}'.format(table=known_args.category, lw=known_args.week, ly=known_args.year),
    '--num_workers=30'
  ])
  pipeline_options = PipelineOptions(pipeline_args)
  pipeline_options.view_as(SetupOptions).save_main_session = True
  jobname = 'reconstruction-from-{table}-pages-week{lw}year{ly}'.format(table=known_args.category, lw=known_args.week, ly=known_args.year)

  json_mapping = lambda x: (json.loads(x)["page_id"], json.loads(x))
  with beam.Pipeline(options=pipeline_options) as p:
    # Read from BigQuery.
    to_be_processed = (p | 'Read_to_be_processed' >> beam.io.ReadFromText(known_args.input.format(week=known_args.week, year=known_args.year))
                          | 'INGESTED_assign_page_id_as_key' >> beam.Map(json_mapping))
    last_revision_location = "gs://wikidetox-viz-dataflow/process_tmp/%s/*last_rev*"
    last_revision = (p | 'Retrieve_last_revision' >> beam.io.ReadFromText(last_revision_location % known_args.category)
                       | 'LASTREV_assign_page_id_as_key' >> beam.Map(json_mapping))
    page_state_location = "gs://wikidetox-viz-dataflow/process_tmp/%s/*page_states*"
    page_state = (p | 'Retrieve_page_state' >> beam.io.ReadFromText(page_state_location % known_args.category)
                    | 'PAGESTATE_assign_page_id_as_key' >> beam.Map(json_mapping))
    reconstruction_results, page_states, last_rev_output\
                   = ({'to_be_processed': to_be_processed, 'last_revision': last_revision, 'page_state': page_state}
                   # Join information based on page_id.
                   | beam.CoGroupByKey()
                   | beam.ParDo(ReconstructConversation()).with_outputs('page_states','last_revision', main = 'reconstruction_results'))
                   # Reconstruct the conversations.
    # Saving page states and latest processed revisionn to cloud for future
    # processing.
    page_states | "WritePageStates" >> beam.io.WriteToText("gs://wikidetox-viz-dataflow/process_tmp/next_%s/page_states" % known_args.category)
    reconstruction_results | "WriteReconstructedResults" >> beam.io.WriteToText("gs://wikidetox-viz-dataflow/reconstructed_res/%s" % jobname)
    last_rev_output | "WriteCollectedLastRevision" >> beam.io.WriteToText("gs://wikidetox-viz-dataflow/process_tmp/next_%s/last_rev" % known_args.category)

class ReconstructConversation(beam.DoFn):
  def merge(self, ps1, ps2):
       # Merge two page states, ps1 is the later one
       deleted_ids_ps2 = {d[1]:d for d in ps2['deleted_comments']}
       deleted_ids_ps1 = {d[1]:d for d in ps1['deleted_comments']}
       deleted_ids_ps2.update(deleted_ids_ps1)
       extra_ids = [key for key in deleted_ids_ps2.keys() if not(key in deleted_ids_ps1)]
       ret_p = copy.deepcopy(ps1)
       ret_p['deleted_comments'] = list(deleted_ids_ps2.values())
       conv_ids = ps2['conversation_id']
       auth = ps2['authors']
       ret_p['conversation_id'] = ret_p['conversation_id']
       ret_p['authors'] = ret_p['authors']
       for i in extra_ids:
           ret_p['conversation_id'][i] = conv_ids[i]
           ret_p['authors'][i] = auth[i]
       ret_p['conversation_id'] = ret_p['conversation_id']
       ret_p['authors'] = ret_p['authors']
       return ret_p

  def process(self, info):
    (page_id, data) = info
    if (page_id == None): return
    logging.info('USERLOG: Reconstruction work start on page: %s' % page_id)

    # Load input from cloud
    rows = data['to_be_processed']
    last_revision = data['last_revision']
    page_state = data['page_state']
    # Clean type formatting
    if not(last_revision == []):
       assert(len(last_revision) == 1)
       last_revision = last_revision[0]
    else:
       last_revision = None
    if not(page_state == []):
       assert(len(page_state) == 1)
       page_state = page_state[0]
    else:
       page_state = None
    for r in rows:
        r['rev_id'] = int(r['rev_id'])

    # Return when the page doesn't have updates to be processed
    if rows == []:
       assert((last_revision and page_state) or \
              ((last_revision == None) and (page_state == None)))
       if last_revision:
          yield beam.pvalue.TaggedOutput('last_revision_output', json.dumps(last_revision))
          yield beam.pvalue.TaggedOutput('page_states', json.dumps(page_state))
       return

    processor = Conversation_Constructor()
    if page_state:
       logging.info('Page %s existed: loading page state.' % (page_id))
       # Load previous page state.
       processor.load(page_state['deleted_comments'])
       latest_content = last_revision['text']

    # Initialize
    revision = {}
    last_revision_id = 'None'
    page_state_bak = None
    cnt = 0
    # Sort revisions by temporal order.
    revision_lst = sorted([r for r in rows], key=lambda k: (k['timestamp'], k['rev_id']))
    last_loading = 0
    for revision in revision_lst:
        # Process revision by revision.
        if not('rev_id' in revision): continue
        cnt += 1
        last_revision_id = revision['rev_id']
        page_state, actions, latest_content = processor.process(page_state, latest_content, revision)
        for action in actions:
            yield json.dumps(action)
        if cnt % LOG_INTERVAL == 0 and cnt and not(page_state == []):
          # Reload after every LOG_INTERVAL revisions to keep the low memory
          # usage.
           processor = Conversation_Constructor()
           page_state_bak = copy.deepcopy(page_state)
           last_loading = cnt
           processor.load(page_state['deleted_comments'])
    if page_state_bak and not(cnt == last_loading):
       # Merge the last two page states if a reload happens while processing,
       # otherwise in a situation where a week's data contains LOG_INTERVAL + 1
       # revisions, the page state may only contain data from one revision.
       page_state = self.merge(page_state, second_last_page_state)
    assert(page_state and not(page_state == None))
    yield beam.pvalue.TaggedOutput('page_states', json.dumps(page_state))
    yield beam.pvalue.TaggedOutput('last_revision', json.dumps({'page_id': page_id, 'text': latest_content}))
    logging.info('USERLOG: Reconstruction on page %s complete! last revision: %s' % (page_id, last_revision_id))

if __name__ == '__main__':
  logging.getLogger().setLevel(logging.INFO)
  parser = argparse.ArgumentParser()
  # Input/Output parameters.
  parser.add_argument('--category',
                      dest='category',
                      help='Specify the job category: long (pages), short (pages),test.')
  parser.add_argument('--input',
                      dest='input',
                      help='Input storage.')
  parser.add_argument('--week',
                      dest='week',
                      default=1,
                      help='The week of data you want to process')
  parser.add_argument('--year',
                      dest='year',
                      default=None,
                      help='The year that the week is in')
  known_args, pipeline_args = parser.parse_known_args()
  run(known_args, pipeline_args)
