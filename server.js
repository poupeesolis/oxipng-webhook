// server.js
import express from "express";
import fetch from "node-fetch";
import { execa } from "execa";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { join } from "path";
import { writeFile, readFile, rm } from "fs/promises";
import oxipngPath from "oxipng-bin";

const app = express();
app.use(express.json({ limit: "5mb" }));

// (Optionnel) Sécuriser par token: mets une valeur dans la variable d'env TOKEN côté hébergeur.
function checkAuth(req, res) {
  const need = process.env.TOKEN;
  if (!need) return true; // pas de token requis si TOKEN vide
  const got = (req.headers.authorization || "").replace("Bearer ", "");
  if (got !== need) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Petit OK de santé
app.get("/", (req, res) => res.json({ ok: true, service: "oxipng-webhook" }));

// Stockage en mémoire 10 minutes pour servir le fichier compressé
const files = new Map(); // id -> { buffer, mime, expiry }
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of files) if (v.expiry < now) files.delete(id);
}, 30_000);

app.get("/files/:id", (req, res) => {
  const v = files.get(req.params.id);
  if (!v) return res.status(404).end("Not found or expired");
  res.setHeader("Content-Type", v.mime || "image/png");
  res.send(v.buffer);
});

// Endpoint principal: compresser un PNG à partir d'une URL
app.post("/compress", async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { url, filename } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    // 1) Télécharger l'image source
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const mime = r.headers.get("content-type") || "application/octet-stream";
    if (!mime.includes("png")) {
      return res.status(415).json({ error: "Only PNG is supported (Oxipng)." });
    }
    const srcBuf = Buffer.from(await r.arrayBuffer());

    // 2) Ecrire dans /tmp
    const inPath = join(tmpdir(), `in-${randomBytes(6).toString("hex")}.png`);
    const outPath = join(tmpdir(), `out-${randomBytes(6).toString("hex")}.png`);
    await writeFile(inPath, srcBuf);

    // 3) Lancer Oxipng (niveau 4 + suppression métadonnées)
    await execa(oxipngPath, ["-o", "4", "--strip", "all", "--out", outPath, inPath], {
      stdio: "inherit",
    });

    // 4) Charger le résultat, garder 10 minutes en mémoire
    const outBuf = await readFile(outPath);
    const id = randomBytes(8).toString("hex");
    files.set(id, { buffer: outBuf, mime: "image/png", expiry: Date.now() + 10 * 60 * 1000 });

    // Nettoyage des fichiers temporaires
    await Promise.allSettled([rm(inPath, { force: true }), rm(outPath, { force: true })]);

    // 5) Retourner une URL publique temporaire
    const base = `${req.protocol}://${req.get("host")}`;
    const publicUrl = `${base}/files/${id}`;
    res.json({
      url: publicUrl,
      suggestedFilename: (filename || "image") + ".png"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("oxipng webhook listening on :" + port));
