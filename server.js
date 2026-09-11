import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });
const runRoot = path.join(__dirname, 'runs');
const publicRoot = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = Number(process.env.MAX_ROWS || 10);
const MAX_SEARCH_CANDIDATES = Number(process.env.MAX_SEARCH_CANDIDATES || 8);
const SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-3.8-flash';
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

if (!process.env.GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set. Add it before processing a CSV.');
}

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

app.use(express.json());
app.use(express.static(publicRoot));
app.use('/examples', express.static(path.join(__dirname, 'examples')));
app.use('/runs', express.static(runRoot, { maxAge: '1h' }));

function cleanName(value) {
  return String(value || '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'property';
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

function uniqueUrls(values) {
  return [...new Set(values.filter(Boolean).map((url) => {
    try { return new URL(url).href; } catch { return null; }
  }).filter((url) => url && /^https?:/i.test(url)))];
}

function isLikelyPhotoUrl(url) {
  const value = String(url || '').toLowerCase();
  return !/(\.svg(?:$|[?#])|\.ico(?:$|[?#])|favicon|logo|icon|sprite|badge|avatar|placeholder)/i.test(value);
}

function urlsFromText(text) {
  return String(text || '').match(/https?:\/\/[^\s)<>"']+/gi) || [];
}

async function searchProperty(property) {
  if (!ai) throw new Error('GEMINI_API_KEY is missing.');
  const place = [property.property_name, property.city, property.country].filter(Boolean).join(', ');
  const prompt = `Find the real-world property called "${place}". Search for its official website or authoritative pages with clear exterior, entrance, mall, hotel, or surrounding-area photos. Do not invent URLs. Return a concise answer with the best source pages and why each is relevant.`;
  const response = await ai.models.generateContent({
    model: SEARCH_MODEL,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }] }
  });
  const grounded = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const groundedUrls = grounded.map((chunk) => chunk.web?.uri).filter(Boolean);
  return uniqueUrls([...groundedUrls, ...urlsFromText(response.text)]).slice(0, 12);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'POI-Image-Factory/1.0 (+property-image-review)' }
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return null;
    return { html: await response.text(), finalUrl: response.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function imageUrlsFromPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = [];
  $('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]').each((_, node) => {
    found.push($(node).attr('content'));
  });
  $('img').each((_, node) => {
    found.push($(node).attr('src'));
    found.push($(node).attr('data-src'));
    const srcset = $(node).attr('srcset') || $(node).attr('data-srcset');
    if (srcset) found.push(srcset.split(',').pop()?.trim().split(/\s+/)[0]);
  });
  return uniqueUrls(found.map((url) => {
    try { return new URL(url, pageUrl).href; } catch { return null; }
  })).filter(isLikelyPhotoUrl);
}

async function collectImageCandidates(sourcePages) {
  const candidates = [];
  for (const page of sourcePages) {
    const fetched = await fetchHtml(page);
    if (!fetched) continue;
    for (const imageUrl of imageUrlsFromPage(fetched.html, fetched.finalUrl)) {
      candidates.push({ imageUrl, sourcePage: fetched.finalUrl });
      if (candidates.length >= MAX_SEARCH_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'POI-Image-Factory/1.0 (+property-image-review)' }
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    // Search pages commonly expose SVG logos and icons as image candidates.
    // Gemini image understanding expects a raster photo here, so reject them early.
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(type.split(';')[0].toLowerCase())) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) return null;
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height) return null;
    return { bytes, mimeType: type.split(';')[0], width: metadata.width, height: metadata.height };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectImage(property, image) {
  if (!ai) throw new Error('GEMINI_API_KEY is missing.');
  const place = [property.property_name, property.city, property.country].filter(Boolean).join(', ');
  const response = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } },
        { text: `Evaluate this image for the real-world property "${place}". This is for a premium property/mall/hotel POI image. Return JSON only: {"score":0-100,"usable":true|false,"looks_like_property":true|false,"is_blurry":true|false,"has_unwanted_text":true|false,"has_invented_or_irrelevant_elements":true|false,"reason":"short explanation"}. Prefer a real exterior, entrance, facade, courtyard, atrium, or wider property-area view. Reject logos, screenshots, menus, close-up food photos, and unrelated buildings.` }
      ]
    }],
    config: { responseMimeType: 'application/json' }
  });
  return parseJson(response.text) || { score: 0, usable: false, reason: 'The image evaluator returned an unreadable response.' };
}

async function generateFromReference(property, image) {
  if (!ai) throw new Error('GEMINI_API_KEY is missing.');
  const place = [property.property_name, property.city, property.country].filter(Boolean).join(', ');
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } },
        { text: `Create a high-resolution, realistic landscape POI photograph of the same property: ${place}. Use the reference image as the source of truth. Preserve the same building, entrance, architecture, layout, colors, visible landscaping, and surrounding context. Do not add or remove buildings, restaurants, people, signs, logos, text, or architectural details. Do not invent a different property. Do not add any labels or captions. Keep the composition wide and suitable for a 2:1 crop.` }
      ]
    }],
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
  });
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData?.data) {
      return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  return null;
}

async function generateWithoutReference(property) {
  if (!ai) throw new Error('GEMINI_API_KEY is missing.');
  const place = [property.property_name, property.city, property.country].filter(Boolean).join(', ');
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: `Create a realistic landscape POI photograph inspired only by the real property "${place}". Show a wide exterior, entrance, facade, courtyard, atrium, or larger property-area view appropriate for a premium hotel, mall, or destination. Do not add any text, labels, logos, named restaurants, or invented nearby landmarks. Do not claim exact architectural accuracy if no trustworthy reference image is available. Wide composition, suitable for a 2:1 crop.`,
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
  });
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData?.data) {
      return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  return null;
}

async function writeOutputs(rawImage, outputDir, baseName) {
  const masterPath = path.join(outputDir, `${baseName}.jpg`);
  await sharp(rawImage.bytes).resize(1600, 800, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92, mozjpeg: true }).toFile(masterPath);
  return { masterPath };
}

async function processProperty(property, runDir) {
  // Include city so duplicate property names do not overwrite one another.
  const name = cleanName([property.property_name, property.city].filter(Boolean).join('-'));
  const sourcePages = await searchProperty(property);
  const candidates = await collectImageCandidates(sourcePages);
  let chosen = null;
  let inspection = null;
  let sourceUrl = null;
  let mode = 'generated_without_reference';

  for (const candidate of candidates) {
    const downloaded = await downloadImage(candidate.imageUrl);
    if (!downloaded) continue;
    const result = await inspectImage(property, downloaded);
    if (result.usable && Number(result.score) >= 70) {
      chosen = downloaded;
      inspection = result;
      sourceUrl = candidate.imageUrl;
      mode = 'source_image';
      break;
    }
  }

  if (!chosen && candidates.length) {
    for (const candidate of candidates) {
      const downloaded = await downloadImage(candidate.imageUrl);
      if (!downloaded) continue;
      const generated = await generateFromReference(property, downloaded);
      if (generated) {
        chosen = generated;
        sourceUrl = candidate.imageUrl;
        mode = 'generated_from_reference';
        inspection = { score: null, usable: true, reason: 'Generated from the strongest downloadable reference candidate.' };
        break;
      }
    }
  }

  if (!chosen) {
    chosen = await generateWithoutReference(property);
    mode = 'generated_without_reference';
    inspection = chosen
      ? await inspectImage(property, chosen)
      : { score: 0, usable: false, reason: 'No usable downloadable reference image was found and generation failed.' };
  }

  if (!chosen) throw new Error('No image could be produced.');
  const outputs = await writeOutputs(chosen, runDir, name);
  return {
    property_name: property.property_name,
    city: property.city,
    country: property.country,
    mode,
    source_url: sourceUrl,
    searched_pages: sourcePages,
    inspection,
    image_url: `/runs/${path.basename(runDir)}/${path.basename(outputs.masterPath)}`,
    master_image_url: `/runs/${path.basename(runDir)}/${path.basename(outputs.masterPath)}`
  };
}

async function createZip(runDir, results) {
  const zipPath = path.join(runDir, 'poi-images.zip');
  await new Promise((resolve, reject) => {
    const output = requireStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const result of results) {
      const filename = path.basename(new URL(`http://localhost${result.master_image_url}`).pathname);
      archive.file(path.join(runDir, filename), { name: filename });
    }
    archive.finalize();
  });
  return `/runs/${path.basename(runDir)}/poi-images.zip`;
}

function requireStream(filePath) {
  // Keeping this tiny helper here avoids mixing promise-based fs with the archive stream.
  return createWriteStream(filePath);
}

app.post('/api/process', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a CSV file.' });
    if (!ai) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    const rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true });
    const properties = rows.map((row) => ({ property_name: row.property_name || row.name || '', city: row.city || '', country: row.country || '' })).filter((row) => row.property_name);
    if (!properties.length) return res.status(400).json({ error: 'CSV must contain property_name, city, and country columns.' });
    if (properties.length > MAX_ROWS) return res.status(400).json({ error: `This starter version accepts up to ${MAX_ROWS} rows at a time.` });

    const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const runDir = path.join(runRoot, runId);
    await fs.mkdir(runDir, { recursive: true });
    const results = [];
    for (const property of properties) {
      try {
        results.push(await processProperty(property, runDir));
      } catch (error) {
        results.push({ ...property, error: error.message });
      }
    }
    const successful = results.filter((result) => result.image_url);
    const zipUrl = successful.length ? await createZip(runDir, successful) : null;
    res.json({ runId, results, zipUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Processing failed.' });
  }
});

app.listen(PORT, () => console.log(`POI Image Factory running on port ${PORT}`));
