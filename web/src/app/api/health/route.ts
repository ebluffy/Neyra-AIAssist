import metadata from '../../../../package.json';
export function GET() { return Response.json({ ok: true, app: 'web', version: metadata.version }); }
