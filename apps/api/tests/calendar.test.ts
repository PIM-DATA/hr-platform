import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
let admin: Session, hr: Session, emp: Session;
let orgA: string, orgB: string;

beforeAll(async () => {
  await resetDatabase();
  orgA = (await prisma.organization.create({ data: { code: 'CA', name: 'Cal A' } })).id;
  orgB = (await prisma.organization.create({ data: { code: 'CB', name: 'Cal B' } })).id;
  await createUser({ email: 'admin@cal.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hr@cal.local', password: PW, role: 'HR' }); // calendar.view only
  await createUser({ email: 'emp@cal.local', password: PW, role: 'EMPLOYEE' });
  [admin, hr, emp] = await Promise.all(['admin', 'hr', 'emp'].map((u) => loginAs(app, `${u}@cal.local`, PW)));
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

const create = (s: Session, body: object) => as(s, 'post', '/api/v1/calendars').send({ organizationId: orgA, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], ...body });

describe('permissions', () => {
  it('1. unauthenticated → 401; 2. without calendar.view → 403; 3. calendar.view reads; 4. view-only cannot mutate; 5. manage can', async () => {
    expect((await request(app).get('/api/v1/calendars')).status).toBe(401);
    expect((await as(emp, 'get', '/api/v1/calendars')).status).toBe(403);
    expect((await as(hr, 'get', '/api/v1/calendars')).status).toBe(200);
    expect((await create(hr, {})).status).toBe(403);
    expect((await as(hr, 'patch', `/api/v1/calendars/organizations/${orgA}/default`).send({ calendarId: null })).status).toBe(403);
    const res = await create(admin, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'STD', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], isActive: true, isDefault: false, holidayCount: 0, organization: { code: 'CA' } });
    expect((await as(hr, 'get', `/api/v1/calendars/${res.body.data.id}`)).status).toBe(200);
  });
});

describe('calendars', () => {
  it('6/7/8. duplicate code in same org rejected, same code in another org allowed; working days normalized', async () => {
    const dup = await create(admin, { code: 'std' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CALENDAR_CODE_ALREADY_EXISTS');
    const other = await create(admin, { organizationId: orgB, workingDays: ['SAT', 'MON'] });
    expect(other.status).toBe(201);
    expect(other.body.data.workingDays).toEqual(['MON', 'SAT']); // deterministic order
  });
  it('9/10/11. invalid, duplicate and empty working days rejected', async () => {
    for (const [code, days] of [['W1', ['MON', 'FUNDAY']], ['W2', ['MON', 'MON']], ['W3', []], ['W4', 'MON']] as const) {
      const res = await create(admin, { code, workingDays: days });
      expect(res.status, code).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.workCalendar.count({ where: { code: { startsWith: 'W' } } })).toBe(0);
  });
  it('update: code/name/workingDays with audit diff; unknown org on create → 404', async () => {
    const cal = (await as(admin, 'get', '/api/v1/calendars?organizationId=' + orgA)).body.data[0];
    const res = await as(admin, 'patch', `/api/v1/calendars/${cal.id}`).send({ name: 'Standard Mon–Sat', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] });
    expect(res.status).toBe(200);
    expect(res.body.data.workingDays).toHaveLength(6);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_CALENDAR', recordId: cal.id } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ name: 'Standard Mon–Sat', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] });
    await as(admin, 'patch', `/api/v1/calendars/${cal.id}`).send({ workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
    expect((await create(admin, { organizationId: 'nope', code: 'X' })).body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
  it('12. set default; 13. other-org calendar rejected; 14. inactive cannot become default; 15. default cannot deactivate; 16. clear then deactivate', async () => {
    const calA = (await as(admin, 'get', '/api/v1/calendars?organizationId=' + orgA)).body.data[0];
    const calB = (await as(admin, 'get', '/api/v1/calendars?organizationId=' + orgB)).body.data[0];
    const set = await as(admin, 'patch', `/api/v1/calendars/organizations/${orgA}/default`).send({ calendarId: calA.id });
    expect(set.status).toBe(200);
    expect((await as(admin, 'get', `/api/v1/calendars/${calA.id}`)).body.data.isDefault).toBe(true);
    expect((await as(admin, 'get', `/api/v1/organizations/${orgA}`)).body.data.defaultCalendar).toMatchObject({ code: 'STD' });
    expect(await prisma.auditLog.count({ where: { action: 'SET_DEFAULT_CALENDAR', recordId: orgA } })).toBe(1);
    const mismatch = await as(admin, 'patch', `/api/v1/calendars/organizations/${orgA}/default`).send({ calendarId: calB.id });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('CALENDAR_ORGANIZATION_MISMATCH');
    await as(admin, 'patch', `/api/v1/calendars/${calB.id}/deactivate`);
    const inactive = await as(admin, 'patch', `/api/v1/calendars/organizations/${orgB}/default`).send({ calendarId: calB.id });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('CALENDAR_INACTIVE');
    const blocked = await as(admin, 'patch', `/api/v1/calendars/${calA.id}/deactivate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CALENDAR_IN_USE');
    expect((await as(admin, 'patch', `/api/v1/calendars/organizations/${orgA}/default`).send({ calendarId: null })).status).toBe(200);
    expect((await as(admin, 'get', `/api/v1/organizations/${orgA}`)).body.data.defaultCalendar).toBeNull();
    expect((await as(admin, 'patch', `/api/v1/calendars/${calA.id}/deactivate`)).body.data.isActive).toBe(false);
    expect((await as(admin, 'patch', `/api/v1/calendars/${calA.id}/activate`)).body.data.isActive).toBe(true);
    await as(admin, 'patch', `/api/v1/calendars/organizations/${orgA}/default`).send({ calendarId: calA.id });
    expect((await as(admin, 'patch', `/api/v1/calendars/organizations/nope/default`).send({ calendarId: null })).status).toBe(404);
  });
});

describe('holidays', () => {
  it('17. create; 18. duplicate date rejected; 19. invalid real-world date rejected; 20. weekend holiday allowed; activate/deactivate; update', async () => {
    const cal = (await as(admin, 'get', '/api/v1/calendars?organizationId=' + orgA)).body.data[0];
    const res = await as(admin, 'post', `/api/v1/calendars/${cal.id}/holidays`).send({ date: '2026-12-31', name: "New Year's Eve" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ date: '2026-12-31', isActive: true });
    const dup = await as(admin, 'post', `/api/v1/calendars/${cal.id}/holidays`).send({ date: '2026-12-31', name: 'dup' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('HOLIDAY_ALREADY_EXISTS');
    for (const bad of ['2026-02-30', '31-12-2026', '2026-1-5']) {
      const r = await as(admin, 'post', `/api/v1/calendars/${cal.id}/holidays`).send({ date: bad, name: 'x' });
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    const weekend = await as(admin, 'post', `/api/v1/calendars/${cal.id}/holidays`).send({ date: '2026-09-26', name: 'Saturday holiday' }); // Saturday
    expect(weekend.status).toBe(201);
    const off = await as(admin, 'patch', `/api/v1/holidays/${weekend.body.data.id}/deactivate`);
    expect(off.body.data.isActive).toBe(false);
    expect((await as(hr, 'get', `/api/v1/calendars/${cal.id}/holidays?status=active`)).body.data).toHaveLength(1);
    expect((await as(hr, 'get', `/api/v1/calendars/${cal.id}/holidays?year=2026`)).body.data).toHaveLength(2);
    expect((await as(admin, 'patch', `/api/v1/holidays/${weekend.body.data.id}/activate`)).body.data.isActive).toBe(true);
    const upd = await as(admin, 'patch', `/api/v1/holidays/${res.body.data.id}`).send({ name: 'NYE', date: '2026-12-30' });
    expect(upd.status).toBe(200);
    expect(JSON.parse((await prisma.auditLog.findFirst({ where: { action: 'UPDATE_HOLIDAY', recordId: res.body.data.id } }))!.newValue!)).toEqual({ date: '2026-12-30', name: 'NYE' });
    expect((await as(hr, 'post', `/api/v1/calendars/${cal.id}/holidays`).send({ date: '2026-01-01', name: 'x' })).status).toBe(403);
    expect((await as(admin, 'get', `/api/v1/calendars/${cal.id}`)).body.data.holidayCount).toBe(2);
  });
});

describe('organization timezone', () => {
  it('defaults to Asia/Bangkok; valid IANA accepted with UPDATE_ORGANIZATION audit; invalid rejected', async () => {
    expect((await as(admin, 'get', `/api/v1/organizations/${orgA}`)).body.data.timezone).toBe('Asia/Bangkok');
    const ok = await as(admin, 'patch', `/api/v1/organizations/${orgA}`).send({ timezone: 'Asia/Tokyo' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.timezone).toBe('Asia/Tokyo');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_ORGANIZATION', recordId: orgA }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ timezone: 'Asia/Tokyo' });
    for (const bad of ['GMT+7-custom', 'abc', '+07:00']) {
      const r = await as(admin, 'patch', `/api/v1/organizations/${orgA}`).send({ timezone: bad });
      expect(r.status, bad).toBe(400);
    }
    expect((await as(admin, 'get', `/api/v1/organizations/${orgA}`)).body.data.timezone).toBe('Asia/Tokyo');
    expect((await as(hr, 'patch', `/api/v1/organizations/${orgA}`).send({ timezone: 'UTC' })).status).toBe(403); // organization.manage required
  });
});
