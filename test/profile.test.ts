import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let ayesha: TestUser;
let png: Buffer;

beforeAll(async () => {
  t = await createCtx();
  png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4F46E5' } }).png().toBuffer();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
});

describe('my profile', () => {
  it('changes my name, and rejects a name that is too short', async () => {
    const r = await t.call('PATCH', '/v1/me', { token: ayesha.token, body: { name: '  Ayesha Khan  ' } });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Ayesha Khan');
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.user.name).toBe('Ayesha Khan');
    expect((await t.call('PATCH', '/v1/me', { token: ayesha.token, body: { name: 'A' } })).status).toBe(400);
    expect((await t.call('PATCH', '/v1/me', { body: { name: 'Nope' } })).status).toBe(401);
  });

  it('sets a profile picture that anyone with the link can load, then removes it', async () => {
    const r = await t.upload('/v1/me/photo', ayesha.token, [{ name: 'me.png', data: png, type: 'image/png' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const url: string = r.body.photoUrl;
    expect(url).toMatch(/^\/v1\/avatars\//);
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.user.photoUrl).toBe(url);

    const img = await t.app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([480, 480]); // a square crop

    const forged = url.replace(/\/[^/?]+\?/, '/AAAAAAAAAAAAAAAAAAAAAAAAAAA?');
    expect((await t.app.inject({ method: 'GET', url: forged })).statusCode).toBe(404);

    expect((await t.call('DELETE', '/v1/me/photo', { token: ayesha.token })).status).toBe(204);
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.user.photoUrl).toBeNull();
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('refuses a file that is not a picture', async () => {
    const r = await t.upload('/v1/me/photo', ayesha.token, [{ name: 'x.png', data: Buffer.from('not a picture'), type: 'image/png' }]);
    expect(r.status).toBe(400);
  });
});
