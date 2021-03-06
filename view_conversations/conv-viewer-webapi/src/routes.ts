/*
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
*/
import * as spanner from '@google-cloud/spanner';
import * as express from 'express';

import * as config from './config';
import * as httpcodes from './http-status-codes';
import * as runtime_types from './runtime_types';
import * as db_types from './db_types';

export class NoResultsError extends Error {}

const SEARCH_BY_TYPE = new runtime_types.RuntimeStringType<string>(
    'SearchBy', /^(conversation_id|rev_id|page_id|page_title|id)$/);

const SEARCH_OP_TYPE =
    new runtime_types.RuntimeStringType<string>('SearchBy', /^(=|LIKE)$/);

// TODO(ldixon): in time we can maybe make this a bit smarter and support
// escaped quotes.
const SQL_SAFE_STRING =
    new runtime_types.RuntimeStringType<string>('SearchBy', /^[^"]+$/);
const parentIdIndex = '_by_parent_id';
const usernameIndex = '_by_user_text';
const conversationIdIndex = '_by_conversation_id';
const toxicityIndex = '_by_toxicity';
const whereConditions = ['page_id', 'page_title', 'user_id', 'user_text', 'rev_id', 'comment_id', 'conversation_id', 'isAlive']

// TODO(ldixon): consider using passport auth
// for google cloud project.
export function setup(
    app: express.Express, conf: config.Config,
    spannerDatabase: spanner.Database) {
  const table = `\`${conf.spannerTableName}\``;

  app.get('/api/conversation-id/:conv_id', async (req, res) => {
    try {
      const conv_id: runtime_types.ConversationId =
          runtime_types.ConversationId.assert(req.params.conv_id);
      const index = conf.spannerTableName + conversationIdIndex;

      // TODO remove outer try wrapper unless it get used.
      // Force Spanner using particular indices to speed up performance.
      const sqlQuery = `SELECT *
             FROM ${table}@{FORCE_INDEX=${index}}
             WHERE conversation_id="${conv_id}"
             LIMIT 100`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql
      const query: spanner.Query = {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(JSON.stringify(db_types.parseOutputRows<db_types.OutputRow>(rows), null, 2));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/toxicity/:options', async (req, res) => {
    try {
      console.log("RECEVED REQUEST")
      const options: runtime_types.apiRequest = runtime_types.assertAPIRequest(JSON.parse(decodeURI(req.params.options)));
      console.log(options);
      let index = conf.spannerTableName + toxicityIndex;
      if (options['user_text'] !== undefined) {
        index = conf.spannerTableName + usernameIndex;
      }
      if (options.order === 'ASC') {
        index = index + '_ASC';
      }
      let whereQueryConditions : string[] = [];
      for (let condition of whereConditions) {
        if (options[condition] !== undefined) {
          if (condition !== 'isAlive' && condition !== 'rev_id') {
            whereQueryConditions.push(` and ${condition} = "${options[condition]}"`);
          } else {
            whereQueryConditions.push(` and ${condition} = ${options[condition]}`);
          }
        }
      }
      // TODO remove outer try wrapper unless it get used.
      const sqlQuery = `SELECT *
             FROM ${table}@{FORCE_INDEX=${index}}
             WHERE RockV6_1_TOXICITY < ${options.upper_score} and RockV6_1_TOXICITY > ${options.lower_score} and type != "DELETION"${whereQueryConditions.join('')}
             ORDER BY RockV6_1_TOXICITY ${options.order}
             LIMIT 20`;
      console.log(sqlQuery);
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql
      const query: spanner.Query = {
        sql: sqlQuery
      };
      console.log("QUERY SPANNER");

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        console.log("RECVED ANSWER FROM SPANNER");
        try {
          res.status(httpcodes.OK).send(JSON.stringify(db_types.parseOutputRows<db_types.OutputRow>(rows), null, 2));
        } catch (e) {
         console.log(`*** Failed: `, e);
        }
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/parent-id/:parent_id', async (req, res) => {
    try {
      const parent_id: runtime_types.CommentId =
          runtime_types.CommentId.assert(req.params.parent_id);
      const index = conf.spannerTableName + parentIdIndex;


      // TODO remove outer try wrapper unless it get used.
      // id field is unique.
      const sqlQuery = `
      SELECT parent_id, type, timestamp
      FROM ${table}@{FORCE_INDEX=${index}}
      WHERE parent_id = "${parent_id}"
      ORDER BY timestamp DESC
      LIMIT 1`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql
      const query: spanner.Query = {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });



  app.get('/api/comment-id/:comment_id', async (req, res) => {
    try {
      console.log("COMMENT_ID RECVED  REQUEST");
      const comment_id: runtime_types.CommentId =
          runtime_types.CommentId.assert(req.params.comment_id);
      const index = conf.spannerTableName + conversationIdIndex;


      // TODO remove outer try wrapper unless it get used.
      // id field is unique.
      const sqlQuery = `
      SELECT conv_r.*
      FROM ${table} conv_l
        JOIN ${table}@{FORCE_INDEX=${index}} conv_r
        ON conv_r.conversation_id = conv_l.conversation_id
      WHERE conv_l.id = "${comment_id}" and conv_r.timestamp <= conv_l.timestamp`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql
      const query: spanner.Query = {
        sql: sqlQuery
      };
      console.log("QUERY TO SPANNER");

      await spannerDatabase.run(query).then(results => {
        console.log("GOT ANSWER FROM SPANNER");
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/revision-id/:rev_id', async (req, res) => {
    try {
      const rev_id: runtime_types.RevisionId =
          runtime_types.RevisionId.assert(req.params.rev_id);

      // TODO remove outer try wrapper unless it get used.
      const sqlQuery = `SELECT *
      FROM ${table}
      WHERE rev_id=${rev_id}
      LIMIT 100`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql
      const query: spanner.Query = {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/page-id/:page_id', async (req, res) => {
    try {
      const page_id: runtime_types.PageId =
          runtime_types.PageId.assert(req.params.page_id);

      // TODO remove outer try wrapper unless it get used.
      const sqlQuery = `SELECT *
      FROM ${table}
      WHERE page_id=${page_id}
      LIMIT 100`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql

      const query: spanner.Query = {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/page-title/:page_title', async (req, res) => {
    try {
      const page_title: runtime_types.PageTitleSearch =
          runtime_types.PageTitleSearch.assert(req.params.page_title);

      // TODO remove outer try wrapper unless it get used.
      const sqlQuery = `SELECT *
      FROM ${table}
      WHERE page_title = "${page_title}"
      LIMIT 100`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql

      const query: spanner.Query= {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });

  app.get('/api/search/:search_by/:search_op/:search_for', async (req, res) => {
    if (!SEARCH_BY_TYPE.isValid(req.params.search_by)) {
      const errorMsg = `Error: Invalid searchBy string: ${req.params.search_by}`
      console.error(errorMsg);
      res.status(httpcodes.BAD_REQUEST).send(JSON.stringify({error: errorMsg}));
      return;
    }
    if (!SEARCH_OP_TYPE.isValid(req.params.search_op)) {
      const errorMsg = `Error: Invalid searchOp string: ${req.params.search_op}`
      console.error(errorMsg);
      res.status(httpcodes.BAD_REQUEST).send(JSON.stringify({error: errorMsg}));
      return;
    }
    if (!SQL_SAFE_STRING.isValid(req.params.search_for)) {
      const errorMsg = `Error: Invalid searchFor string: ${req.params.search_for}`
      console.error(errorMsg);
      res.status(httpcodes.BAD_REQUEST).send(JSON.stringify({error: errorMsg}));
      return;
    }
    try {
      // TODO remove outer try wrapper unless it get used.
      const sqlQuery = `SELECT *
      FROM ${table}
      WHERE ${req.params.search_by} ${req.params.search_op} "${
          req.params.search_for}"
      LIMIT 100`;
      // Query options list:
      // https://cloud.google.com/spanner/docs/getting-started/nodejs/#query_data_using_sql

      const query: spanner.Query = {
        sql: sqlQuery
      };

      await spannerDatabase.run(query).then(results => {
        const rows = results[0];
        res.status(httpcodes.OK).send(db_types.parseOutputRows<db_types.OutputRow>(rows));
      });
    } catch (e) {
      console.error(`*** Failed: `, e);
      res.status(httpcodes.INTERNAL_SERVER_ERROR).send(JSON.stringify({
        error: e.message
      }));
    }
  });
}
