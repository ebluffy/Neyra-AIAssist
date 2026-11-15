import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '../../../../../lib/auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Instantiate only on a request, not during Next route collection/build.
export async function GET(request: Request) { return toNextJsHandler(getAuth()).GET(request); }
export async function POST(request: Request) { return toNextJsHandler(getAuth()).POST(request); }
