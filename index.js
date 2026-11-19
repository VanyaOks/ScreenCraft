/**
 * Host half of the screenshot annotator bundle.
 *
 * The browser half draws the annotated PNG, but a browser cannot hand a local
 * file to the agent: the model reads an image from the workspace through the
 * `read_image` tool. This half therefore owns one small write route:
 *
 *   POST /screenshot-annotator/save
 *     { sessionId, dataUrl, cwd? }
 *
 * It validates the PNG, resolves the Session workspace directory, writes the
 * file under `<workspace>/.dsh/annotations/`, and answers with the workspace
 * relative path that the browser half inserts into the composer together with
 * the marker legend.
 *
 * The route is same-origin only, accepts PNG data URLs up to 16 MiB, never
 * follows a caller-supplied path (the directory is resolved from the Session,
 * and the filename is generated here), and keeps the annotation folder small by
 * deleting files older than a week beyond the newest 200.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'screenshot-annotator';
export const inject = ['webServer'];

const ROUTE = '/screenshot-annotator/save';
const BODY_LIMIT = 24 * 1024 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_FILES = 200;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_SIGNATURE = Buffer.from('RIFF');
const FORMAT_EXTENSION = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp' });
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Whether the decoded bytes start with the signature of the declared format. */
function hasSignature(format, bytes) {
  if (format === 'png') return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (format === 'jpeg') return bytes.length > 3 && bytes.subarray(0, 3).equals(JPEG_SIGNATURE);
  if (format === 'webp') {
    return bytes.length > 12
      && bytes.subarray(0, 4).equals(WEBP_SIGNATURE)
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

/** One JSON answer for the browser half. */
function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

/** Read one bounded JSON body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

/** Whether the path is an existing directory. */
async function isDirectory(candidate) {
  try {
    const stats = await stat(candidate);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the directory the Session works in.
 *
 * The browser half only names the Session; the directory itself comes from the
 * live Agent's Session header or from the visible Session summary. A Session
 * that cannot be resolved is an explicit failure: writing into a guessed
 * directory would hand the agent a path that does not match the workspace.
 */
async function resolveSessionDirectory(ctx, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    try {
      const agent = ctx.get('agents')?.get(sessionId);
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '' && (await isDirectory(cwd))) return cwd;
    } catch {
      // Fall through to the Session summary.
    }
    try {
      const controller = ctx.get('sessionController');
      if (controller !== undefined && typeof controller.list === 'function') {
        const value = await controller.list({}, AbortSignal.timeout(4000));
        const items = Array.isArray(value?.items) ? value.items : [];
        const found = items.find((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId);
        const cwd = found?.cwd;
        if (typeof cwd === 'string' && cwd !== '' && (await isDirectory(cwd))) return cwd;
      }
    } catch {
      // Fall through to the explicit failure below.
    }
  }
  throw new Error('не удалось определить рабочую папку сеанса');
}

/** `20261114-125501` in local time. */
function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Keep the annotation folder bounded: newest 200 files, at most a week old. */
async function prune(directory) {
  try {
    const names = await readdir(directory);
    const files = [];
    for (const entry of names) {
      if (!IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
      const full = path.join(directory, entry);
      const stats = await stat(full).catch(() => undefined);
      if (stats !== undefined && stats.isFile()) files.push({ full, mtime: stats.mtimeMs });
    }
    files.sort((left, right) => right.mtime - left.mtime);
    const now = Date.now();
    for (let index = 0; index < files.length; index += 1) {
      if (index >= KEEP_FILES || now - files[index].mtime > KEEP_MS) {
        await unlink(files[index].full).catch(() => {});
      }
    }
  } catch {
    // Pruning is best effort; a failure never blocks the saved annotation.
  }
}

/** Answer one save request. */
async function handleSave(ctx, request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost === undefined || originHost !== request.headers.host) {
      sendJson(response, 403, { error: 'cross-origin request refused' });
      return;
    }
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : 'invalid request' });
    return;
  }
  const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : '';
  const match = DATA_URL.exec(dataUrl);
  if (match === null) {
    sendJson(response, 400, { error: 'ожидался PNG, JPEG или WebP в data URL' });
    return;
  }
  const format = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > IMAGE_LIMIT) {
    sendJson(response, 400, { error: 'недопустимый размер изображения' });
    return;
  }
  if (!hasSignature(format, bytes)) {
    sendJson(response, 400, { error: 'данные не соответствуют формату изображения' });
    return;
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  try {
    const baseDirectory = await resolveSessionDirectory(ctx, sessionId);
    const directory = path.join(baseDirectory, '.dsh', 'annotations');
    await mkdir(directory, { recursive: true });
    const filename = `annotation-${formatStamp(new Date())}-${Math.random().toString(16).slice(2, 6)}.${FORMAT_EXTENSION[format]}`;
    const file = path.join(directory, filename);
    await writeFile(file, bytes);
    const width = Number.isInteger(body?.width) && body.width > 0
      ? Math.min(100000, body.width)
      : (format === 'png' ? bytes.readUInt32BE(16) : 0);
    const height = Number.isInteger(body?.height) && body.height > 0
      ? Math.min(100000, body.height)
      : (format === 'png' ? bytes.readUInt32BE(20) : 0);
    const relativePath = path.relative(baseDirectory, file).split(path.sep).join('/');
    void prune(directory);
    sendJson(response, 200, { path: relativePath, bytes: bytes.length, width, height });
  } catch (error) {
    sendJson(response, 500, {
      error: `не удалось сохранить изображение: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (request, response) => handleSave(ctx, request, response),
  });
  ctx.effect(() => dispose, 'screenshot-annotator: save route');
}
