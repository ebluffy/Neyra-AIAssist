import { it, expect } from 'vitest';
import { GET } from './route';
import metadata from '../../../../package.json';
it('returns the web version without database or auth', async () => {
 const response = GET();
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual({ok:true,app:'web',version:metadata.version});
});
