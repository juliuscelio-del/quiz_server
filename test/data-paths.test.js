// Guards the promise "everything is saved in the app's data folder".
const fs = require("fs"), path = require("path"), assert = require("assert");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "server", f), "utf8");

const server = read("server.js"), lic = read("license-check.js");

assert.ok(/const DATA_DIR = process\.env\.GNHS_DATA_DIR \|\| __dirname;/.test(server), "server.js must define DATA_DIR");
assert.ok(/const DATA_DIR = process\.env\.GNHS_DATA_DIR \|\| __dirname;/.test(lic), "license-check.js must define DATA_DIR");
assert.strictEqual((server.match(/path\.resolve\(__dirname/g) || []).length, 0, "no data path may use __dirname");
assert.strictEqual((lic.match(/path\.resolve\(__dirname/g) || []).length, 0, "license paths must use DATA_DIR");
assert.ok((server.match(/path\.resolve\(DATA_DIR,/g) || []).length >= 16, "all 16 data paths use DATA_DIR");
assert.ok(fs.existsSync(path.join(__dirname, "..", "server", "public", "index.html")), "server/public/index.html (lowercase) must exist");
assert.ok(fs.existsSync(path.join(__dirname, "..", "server", "public", "dashboard.html")), "server/public/dashboard.html must exist");
assert.ok(/app\.post\("\/api\/save-now"/.test(server) && /function flushAll\(/.test(server), "server must expose flushAll + /api/save-now");
assert.ok(fs.existsSync(path.join(__dirname, "..", "electron", "preload.js")), "electron/preload.js must exist");
assert.ok(/preload:/.test(fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8")), "main.js must load the preload");
console.log("✔ every saved file is routed through DATA_DIR; public pages are present");
