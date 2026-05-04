// api/extract.js — Extract text from PowerPoint and Word files
// Deploy to runebook-api Vercel repo as api/extract.js
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const form = formidable({ maxFileSize: 10 * 1024 * 1024 }); // 10MB limit

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: 'File parse error: ' + err.message });

    const file = files.file?.[0] || files.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const ext = path.extname(file.originalFilename || '').toLowerCase();
    const filePath = file.filepath;

    try {
      let text = '';

      if (ext === '.docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
      } else if (ext === '.pptx') {
        const JSZip = (await import('jszip')).default;
        const xml2js = await import('xml2js');

        const data = fs.readFileSync(filePath);
        const zip = await JSZip.loadAsync(data);

        // Extract text from each slide
        const slideFiles = Object.keys(zip.files)
          .filter(f => f.match(/ppt\/slides\/slide\d+\.xml$/))
          .sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)/)[1]);
            const numB = parseInt(b.match(/slide(\d+)/)[1]);
            return numA - numB;
          });

        const slideTexts = [];
        for (const slideFile of slideFiles) {
          const content = await zip.files[slideFile].async('string');
          const parsed = await xml2js.parseStringPromise(content);
          
          // Extract all text elements from the slide
          const slideText = [];
          const extractText = (obj) => {
            if (!obj) return;
            if (typeof obj === 'string') { if (obj.trim()) slideText.push(obj.trim()); return; }
            if (Array.isArray(obj)) { obj.forEach(extractText); return; }
            if (typeof obj === 'object') {
              // Prioritize 't' elements which contain actual text in PPTX
              if (obj['a:t']) extractText(obj['a:t']);
              else Object.values(obj).forEach(extractText);
            }
          };
          extractText(parsed);
          if (slideText.length) {
            const slideNum = slideFile.match(/slide(\d+)/)[1];
            slideTexts.push(`[Slide ${slideNum}]\n${slideText.join(' ')}`);
          }
        }
        text = slideTexts.join('\n\n');

      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use .docx or .pptx' });
      }

      if (!text || text.trim().length < 10) {
        return res.status(400).json({ error: 'Could not extract text from file. Make sure it contains readable text.' });
      }

      // Clean up temp file
      fs.unlinkSync(filePath);

      res.status(200).json({ text: text.trim(), ext });
    } catch (err) {
      console.error('Extract error:', err);
      res.status(500).json({ error: 'Failed to extract text: ' + err.message });
    }
  });
}
