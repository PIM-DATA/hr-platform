import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers';

const app = createTestServer();

describe('GET /api/v1/health', () => {
  it('returns ok with database status', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'ok' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('returns standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_JSON for malformed bodies', async () => {
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
