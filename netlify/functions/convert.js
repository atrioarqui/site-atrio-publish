
import Busboy from 'busboy';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffprobePath from '@ffprobe-installer/ffprobe';
import fs from 'fs';
import os from 'os';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegPath.path);
ffmpeg.setFfprobePath(ffprobePath.path);

export const config = { path: '/convert' };

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: event.headers });
    const fields = {};
    const files = [];
    const fileWrites = [];

    busboy.on('file', (name, file, info) => {
      const { filename } = info;
      const saveTo = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`);
      const writeStream = fs.createWriteStream(saveTo);
      file.pipe(writeStream);
      const promise = new Promise((res, rej) => {
        writeStream.on('close', () => res({ filepath: saveTo, filename, fieldname: name }));
        writeStream.on('error', rej);
      });
      fileWrites.push(promise);
    });

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('finish', async () => {
      try { resolve({ fields, files: await Promise.all(fileWrites) }); }
      catch (e) { reject(e); }
    });

    const buf = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64')
                                      : Buffer.from(event.body || '', 'utf8');
    busboy.end(buf);
  });
}

function scaleFilter(fit='cover') {
  const base = `scale=w=1080:h=1920:force_original_aspect_ratio=${fit==='contain'?'decrease':'increase'}`;
  return fit==='cover' ? `${base},crop=1080:1920`
                       : `${base},pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black`;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors(), body: 'Use POST' };

  try {
    const { fields, files } = await parseMultipart(event);
    if (!files.length) throw new Error('Nenhum arquivo enviado (campo "video").');

    const fit    = (fields.fit || 'cover').toLowerCase();
    const format = (fields.format || 'mp4').toLowerCase(); // mp4 | webm
    const fps    = parseInt(fields.fps || '30', 10);

    const inputFile  = files[0].filepath;
    const outputFile = path.join(os.tmpdir(), `out-${Date.now()}.${format==='webm'?'webm':'mp4'}`);

    let cmd = ffmpeg(inputFile).fps(fps).videoFilters(scaleFilter(fit));

    if (format === 'webm') {
      cmd = cmd.videoCodec('libvpx-vp9').audioCodec('libopus')
        .outputOptions(['-b:v 0', '-crf 30', '-pix_fmt yuv420p', '-movflags +faststart']);
    } else {
      cmd = cmd.videoCodec('libx264').audioCodec('aac').audioBitrate('128k')
        .outputOptions([
          '-preset veryfast', '-profile:v high', '-level 4.0', '-crf 21',
          '-movflags +faststart', '-pix_fmt yuv420p', '-bf 0', '-g 60'
        ]);
    }

    await new Promise((resolve, reject) => {
      cmd.output(outputFile).on('end', resolve).on('error', reject).run();
    });

    const base64 = fs.readFileSync(outputFile).toString('base64');
    try { fs.unlinkSync(outputFile); fs.unlinkSync(inputFile); } catch {}

    return {
      statusCode: 200,
      headers: {
        ...cors(),
        'Content-Type': format==='webm' ? 'video/webm' : 'video/mp4',
        'Content-Disposition': `attachment; filename="converted_1080x1920.${format==='webm'?'webm':'mp4'}"`
      },
      isBase64Encoded: true,
      body: base64
    };
  } catch (err) {
    return { statusCode: 500, headers: cors(), body: `Error: ${err.message}` };
  }
}
