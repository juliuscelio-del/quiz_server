/**
 * GNHS Quiz — LAN discovery beacon (teacher side)
 *
 * Every 2 seconds this shouts "I'm the quiz server" over UDP so the student
 * app can find the teacher's IP automatically. It also adds GET /api/ping,
 * which the student app uses as a backup (subnet scan) and to double-check
 * that what it found really is the quiz server.
 *
 * Nothing here touches quiz logic. If anything fails, it fails silently and
 * the server keeps running exactly as before.
 */
const dgram = require("dgram");
const os = require("os");

const BEACON_PORT = 41234;
const APP_ID = "gnhs-quiz";

function broadcastAddresses() {
  const out = new Set(["255.255.255.255"]);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family !== "IPv4" || n.internal || !n.netmask) continue;
      const ip = n.address.split(".").map(Number);
      const mask = n.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join("."));
    }
  }
  return [...out];
}

function startBeacon(port, name = "Teacher") {
  let sock;
  try {
    sock = dgram.createSocket("udp4");
    sock.on("error", () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (_) {}
      const send = () => {
        const msg = Buffer.from(JSON.stringify({ app: APP_ID, port, name }));
        for (const addr of broadcastAddresses()) {
          try { sock.send(msg, BEACON_PORT, addr, () => {}); } catch (_) {}
        }
      };
      send();
      setInterval(send, 2000).unref();
    });
  } catch (_) { /* never block the quiz server */ }
}

function registerPing(app, port) {
  app.get("/api/ping", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    res.json({ app: APP_ID, ok: true, port });
  });
}

module.exports = { startBeacon, registerPing, BEACON_PORT, APP_ID };
