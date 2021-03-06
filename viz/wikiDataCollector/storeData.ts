
import * as fs from "fs";
import * as path from "path";

export class StoreData {

    public folderPath: string;
    constructor(folderPath) {
        this.folderPath = folderPath;
    }

    /**
     * Write a file
     * @params {String} name of file
     * @params {String | Buffer} content of file
     * @params {Function} callbackk return true or false
     * @params {Object} option { path : }
     *
     */
    public writeFile(name, content, callback, option) {
        option = option || {};

        let conentAsJsonString = "";

        try {
            conentAsJsonString = JSON.stringify(content);
        } catch (e) {
            console.log("Cannot convert to json string, fileName:", name);
        }

        const fileName = name;
        const path = option.path || "";
        const fullPath = __dirname + this.folderPath + path + "/" + fileName;

        fs.writeFile(fullPath, conentAsJsonString, (err) => {
            if (err) {
                callback(false);
                throw err;
            }
            callback(true);
        });
    }

    /**
     * Read a file
     * @params {String} name of file
     * @params {Function} callbackk return true or false
     * @params {Object} option { path : }
     *
     */

    public readFile(name, callback, option) {
        option = option || {};

        const fileName = name;
        const path = option.path || "";
        const fullPath = __dirname + this.folderPath + path + "/" + fileName;

        fs.readFile(fullPath, "utf-8", (err, data) => {
            if (err) {
                throw err;
            }
            callback(data);
        });
    }

    /**
     * Apped data to a file
     * @params {String} name of file
     * @params {String | Buffer} content of file
     * @params {Function} callbackk return true or false
     * @params {Object} option { path : }
     *
     */

    public appendFile(name, content, callback, option) {
        option = option || {};

        let conentAsJsonString = "";

        try {
            conentAsJsonString = JSON.stringify(content);
        } catch (e) {
            console.log("Cannot convert to json string, fileName:", name);
        }

        const fileName = name;
        const path = option.path || "";
        const fullPath = this.folderPath + path + "/" + fileName;

        fs.appendFile(fullPath, conentAsJsonString, (err) => {
            if (err) {
                callback(false);
                throw err;
            }
            callback(true);
        });
    }
    public createFolder(folder) {
        folder = __dirname + this.folderPath + "/" + folder;
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder);
        }
    }
    public clearFolder(directory) {

        directory = __dirname + this.folderPath + "/" + directory;

        fs.readdir(directory, (err, files) => {
            if (err) { throw Error; }

            for (const file of files) {
                fs.unlink(path.join(directory, file), (errUnlink) => {
                    if (errUnlink) { throw Error; }
                });
            }
        });
    }
}
