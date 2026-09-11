# POI Image Factory

This is a Railway-ready starter app that accepts a CSV containing property names and locations, searches for relevant public web pages with Gemini Google Search grounding, extracts candidate images, evaluates them, and creates a high-resolution master plus a 400 × 200 final image.

## 1. Run locally

You need Node.js 20 or newer.

```bash
cd poi-image-factory
cp .env.example .env
```

Open `.env` and set `GEMINI_API_KEY`. Do not commit `.env` or paste the key into GitHub.

```bash
npm install
npm start
```

Open http://localhost:3000.

## 2. CSV format

Use these columns:

```csv
property_name,city,country
DLF Promenade,Vasant Kunj,India
The Leela Palace,Chanakyapuri,India
```

The city and country are important because property names can be duplicated.

## 3. Deploy on Railway from GitHub

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root. The `package.json` file must be at the root.
3. In Railway, choose **New Project → Deploy from GitHub repo** and select the repository.
4. In Railway, open the service’s **Variables** section and add:

   - `GEMINI_API_KEY` = your Gemini API key
   - Optional: `GEMINI_SEARCH_MODEL`, `GEMINI_VISION_MODEL`, `GEMINI_IMAGE_MODEL`

5. Deploy. Railway will run `npm install` and `npm start` automatically.

The app listens on Railway’s `PORT` environment variable. Generated files are kept on the service’s temporary disk and are intended to be downloaded shortly after the job finishes. Do not use this first version as permanent file storage.

## 4. What the app does

- Searches each property with Gemini’s Google Search tool.
- Extracts Open Graph, Twitter card, and ordinary image URLs from found pages.
- Downloads and checks candidate images.
- Uses the first acceptable source image where possible.
- If the source image is usable but small or unsuitable for the requested format, it tries a controlled Gemini image transformation.
- If no downloadable reference is found, it creates a clearly marked generated fallback.
- Exports a 1600 × 800 master and a 400 × 200 final image.
- Adds a `manifest.json` to the ZIP with source URLs and verification information.

## Important limitations

Web pages may block automated downloads, and not every page exposes its images in public HTML. Search results are also not proof that an image is licensed for commercial use. Review the source URL and usage rights before publishing any image.

The generated-without-reference fallback is not guaranteed to be architecturally exact. For production use, keep the review step enabled and reject anything that does not visibly match the property.
