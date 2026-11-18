import { expect, it, vi } from 'vitest';
const guard=vi.hoisted(()=>({getAdminUser:vi.fn()}));
vi.mock('../../../lib/admin-page-guard',()=>guard);
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('404');}}));
vi.mock('../../components/channels/channels-view',()=>({ChannelsView:()=>null}));
import Page from './page';
it('returns 404 without admin session and renders the page for admin',async()=>{
 guard.getAdminUser.mockResolvedValue(null);await expect(Page()).rejects.toThrow('404');
 guard.getAdminUser.mockResolvedValue({id:'admin',role:'admin'});expect(await Page()).toBeTruthy();
});
