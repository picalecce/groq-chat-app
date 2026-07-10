import { PDFParse } from 'pdf-parse';
import { getData } from 'pdf-parse/worker';
import mammoth from 'mammoth';

PDFParse.setWorker(getData());

const MAX_CHARS = 20000;

function truncate(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) {
    return { text: trimmed, truncated: false };
  }
  return { text: trimmed.slice(0, MAX_CHARS), truncated: true };
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return Response.json({ error: 'Nessun file ricevuto.' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  try {
    let rawText: string;

    if (name.endsWith('.pdf')) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      await parser.destroy();
      rawText = result.text;
    } else if (name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value;
    } else if (name.endsWith('.txt')) {
      rawText = buffer.toString('utf-8');
    } else {
      return Response.json(
        { error: 'Formato non supportato. Usa PDF, DOCX o TXT.' },
        { status: 400 },
      );
    }

    if (!rawText.trim()) {
      return Response.json(
        { error: 'Non è stato possibile estrarre testo da questo file.' },
        { status: 422 },
      );
    }

    const { text, truncated } = truncate(rawText);
    return Response.json({ filename: file.name, text, truncated });
  } catch (err) {
    console.error('extract error', err);
    return Response.json(
      { error: 'Errore durante la lettura del documento.' },
      { status: 500 },
    );
  }
}
