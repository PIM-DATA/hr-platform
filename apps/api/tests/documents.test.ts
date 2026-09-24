/**
 * Task 30 — Document center.
 *
 * What these tests guard: that bytes are stored under a key the client never chose and never outside the root,
 * that nothing executable or mislabelled gets in, that a file leaves only through the authenticated download after
 * the classification and linked-module rules, that versions are append-only and concurrent uploads settle on one
 * current version, and that archive and expiry are metadata states, never deletions.
 */
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDispositionFilename, expiryState, matchesSignature, sanitizeFilename } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { LocalFileDocumentStorage, documentStorage } from '../src/modules/documents/storage';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const D = '/api/v1/documents';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0)]);
const upload = (s: Session, url: string, fields: Record<string, string>, file: Buffer, filename: string, mime = 'application/pdf') => {
  let req = request(app).post(url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, { filename, contentType: mime });
};

let hrAdmin: Session, hr: Session, mgr: Session, otherMgr: Session, emp: Session, emp2: Session, exec: Session;
const employees: Record<string, string> = {};
let contractCat: string, payrollCat: string, trainingCat: string, docId: string, enrollmentId: string, caseId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'DOC', name: 'Doc Co', timezone: 'Asia/Bangkok' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  const job = await prisma.job.create({ data: { code: 'ENG', title: 'Engineer', level: 2 } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'ENG1', title: 'Engineer', jobId: job.id } });
  const opsPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OPS1', title: 'Ops', jobId: job.id } });
  const mk = async (code: string, positionId: string, departmentId: string, managerId: string | null) => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@doc.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  employees.HRADM = await mk('HRADM', opsPosition.id, otherDept.id, null);
  employees.MGR = await mk('MGR', position.id, dept.id, null);
  employees.OTHERMGR = await mk('OTHERMGR', opsPosition.id, otherDept.id, null);
  employees.EMP003 = await mk('EMP003', position.id, dept.id, employees.MGR);
  employees.EMP004 = await mk('EMP004', position.id, dept.id, employees.MGR);
  await createUser({ email: 'hradmin@doc.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@doc.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@doc.local', password: PW, role: 'MANAGER', employeeId: employees.MGR });
  await createUser({ email: 'othermgr@doc.local', password: PW, role: 'MANAGER', employeeId: employees.OTHERMGR });
  await createUser({ email: 'emp@doc.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp2@doc.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@doc.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgr, otherMgr, emp, emp2, exec] = await Promise.all(['hradmin', 'hr', 'mgr', 'othermgr', 'emp', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@doc.local`, PW)));
  // A completed training enrollment and an ER case as link targets.
  const course = await prisma.trainingCourse.create({ data: { code: 'SQL101', title: 'SQL basics', deliveryMethod: 'CLASSROOM', durationMinutes: 120, createdByUserId: hrAdmin.user.id } });
  const session = await prisma.trainingSession.create({ data: { courseId: course.id, courseCodeSnapshot: 'SQL101', courseTitleSnapshot: 'SQL basics', startAt: new Date('2026-05-01T02:00:00Z'), endAt: new Date('2026-05-01T04:00:00Z'), timezone: 'Asia/Bangkok', capacity: 10, status: 'COMPLETED', createdByUserId: hrAdmin.user.id } });
  enrollmentId = (await prisma.trainingEnrollment.create({ data: { sessionId: session.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', source: 'MANUAL', status: 'COMPLETED' } })).id;
  caseId = (await prisma.employeeRelationCase.create({ data: { caseNumber: 'ER-2026-000001', employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', incidentDate: '2026-04-01', title: 'Case', description: 'x', createdByUserId: hrAdmin.user.id } })).id;
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('pure rules', () => {
  it('signatures, filenames and expiry', () => {
    expect(matchesSignature('PDF', PDF)).toBe(true);
    expect(matchesSignature('PDF', Buffer.from('<html><script>'))).toBe(false);
    expect(matchesSignature('TEXT', Buffer.from('<!DOCTYPE html><html>'))).toBe(false);
    expect(matchesSignature('TEXT', Buffer.from('a,b,c\n1,2,3'))).toBe(true);
    expect(matchesSignature('TEXT', Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).toBe(false); // MZ + NUL
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\evil.pdf')).toBe('evil.pdf');
    expect(sanitizeFilename('con\u0000tract\u001f.pdf')).toBe('contract.pdf');
    expect(contentDispositionFilename('สัญญา "x".pdf')).toMatch(/^filename="_+ _x_.pdf"; filename\*=UTF-8''%E0%B8/);
    expect(expiryState('2026-01-01', '2026-06-01')).toBe('EXPIRED');
    expect(expiryState('2026-06-15', '2026-06-01')).toBe('EXPIRING_SOON');
    expect(expiryState('2027-06-01', '2026-06-01')).toBe('VALID');
    expect(expiryState(null, '2026-06-01')).toBe('NONE');
  });
  it('the storage adapter refuses every key that is not a generated key inside the root', () => {
    const storage = new LocalFileDocumentStorage(path.join(process.cwd(), '.data/documents-test'));
    for (const bad of ['../evil.pdf', 'documents/../../etc/passwd', '/etc/passwd', 'documents/ab/%2e%2e/x', 'documents/ab/\u0000', 'documents/ab/evil.pdf', 'C:\\\\Windows\\\\x', 'documents/ab/00000000-0000-0000-0000-000000000000/../x']) {
      expect(() => storage.resolve(bad), bad).toThrow();
    }
    const good = storage.resolve('documents/ab/ab000000-0000-4000-8000-000000000000');
    expect(good.startsWith(storage.root + path.sep)).toBe(true);
  });
});

describe('categories and upload', () => {
  it('HR admin defines categories; a manager cannot', async () => {
    expect(err(await as(mgr, 'post', `${D}/categories`).send({ code: 'X', name: 'x' }))).toBe('403 FORBIDDEN');
    contractCat = (await as(hrAdmin, 'post', `${D}/categories`).send({ code: 'CONTRACT', name: 'Employment contract', scopeType: 'EMPLOYEE', defaultClassification: 'EMPLOYEE_PRIVATE', allowedExtensions: ['.pdf'], maxFileSizeBytes: 5 * 1024 * 1024 })).body.data.id;
    payrollCat = (await as(hrAdmin, 'post', `${D}/categories`).send({ code: 'PAYROLL_DOC', name: 'Payroll document', scopeType: 'PAYROLL', defaultClassification: 'HR_CONFIDENTIAL' })).body.data.id;
    trainingCat = (await as(hrAdmin, 'post', `${D}/categories`).send({ code: 'CERT', name: 'Training certificate', scopeType: 'TRAINING', defaultClassification: 'EMPLOYEE_PRIVATE' })).body.data.id;
    expect(contractCat && payrollCat && trainingCat).toBeTruthy();
    expect((await as(emp, 'get', `${D}/policy`)).body.data.malwareScanning).toBe(false);
  });

  it('uploads a PDF as v1 under an opaque key, with its hash and a document number', async () => {
    expect(err(await upload(mgr, D, { title: 'x', categoryId: contractCat }, PDF, 'c.pdf'))).toBe('403 FORBIDDEN');
    const r = await upload(hrAdmin, D, { title: 'Employment contract 2026', categoryId: contractCat, ownerEmployeeId: employees.EMP003, issuedDate: '2026-01-01', expiryDate: '2027-01-01' }, PDF, 'Contract EMP003 (signed).pdf');
    expect(err(r)).toBe('201');
    const d = r.body.data;
    docId = d.id;
    expect(d.documentNumber).toMatch(/^DOC-\d{4}-000001$/);
    expect(d.classification).toBe('EMPLOYEE_PRIVATE');
    expect(d.currentVersion).toMatchObject({ versionNumber: 1, originalFilename: 'Contract EMP003 (signed).pdf', mimeType: 'application/pdf', fileSize: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex') });
    expect(d.expiryState).toBe('VALID');
    expect(JSON.stringify(d)).not.toMatch(/storageKey|documents\/[0-9a-f]{2}\//);
    const version = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: docId } });
    expect(version.storageKey).toMatch(/^documents\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(version.storageKey).not.toContain('Contract');
    expect(await documentStorage().exists(version.storageKey)).toBe(true);
    const root = (documentStorage() as LocalFileDocumentStorage).root;
    expect(readdirSync(root).some((n) => /Contract|EMP003/.test(n))).toBe(false);
  });

  it('rejects executables, scripts, HTML, SVG, mismatched content, mismatched MIME, oversize and traversal names', async () => {
    const cases: [Buffer, string, string, string][] = [
      [Buffer.from('MZ\u0000\u0000'), 'setup.exe', 'application/octet-stream', 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [Buffer.from('#!/bin/sh\nrm -rf /'), 'run.sh', 'text/plain', 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [Buffer.from('alert(1)'), 'x.js', 'text/javascript', 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'page.html', 'text/html', 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [Buffer.from('<svg onload="alert(1)"/>'), 'img.svg', 'image/svg+xml', 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'notes.txt', 'text/plain', 'DOCUMENT_CONTENT_MISMATCH'],
      [Buffer.from('MZ\u0000\u0000 renamed executable'), 'report.pdf', 'application/pdf', 'DOCUMENT_CONTENT_MISMATCH'],
      [PDF, 'report.pdf', 'text/html', 'DOCUMENT_TYPE_MISMATCH'],
      [PNG, 'photo.png', 'application/pdf', 'DOCUMENT_TYPE_MISMATCH'],
      [Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024, 0x20)]), 'big.pdf', 'application/pdf', 'DOCUMENT_TOO_LARGE'],
    ];
    for (const [buf, name, mime, code] of cases) {
      const r = await upload(hrAdmin, D, { title: name, categoryId: name.endsWith('.pdf') && !name.startsWith('big') ? trainingCat : name === 'big.pdf' ? contractCat : trainingCat }, buf, name, mime);
      expect(err(r), name).toBe(`${r.status} ${code}`);
    }
    // A traversal filename is stored as its sanitized base name and never as a path.
    const trav = await upload(hrAdmin, D, { title: 'Traversal', categoryId: trainingCat }, PDF, '../../etc/passwd.pdf');
    expect(err(trav)).toBe('201');
    expect(trav.body.data.currentVersion.originalFilename).toBe('passwd.pdf');
    const enc = await upload(hrAdmin, D, { title: 'Encoded', categoryId: trainingCat }, PDF, '%2e%2e%2f%2e%2e%2fetc%2fpasswd.pdf');
    expect(err(enc)).toBe('201');
    expect(existsSync(path.join((documentStorage() as LocalFileDocumentStorage).root, '..', 'etc'))).toBe(false);
    expect(await prisma.documentVersion.count({ where: { storageKey: { contains: '..' } } })).toBe(0);
    // Nothing was stored for the refused uploads.
    expect(await prisma.document.count()).toBe(3);
  });

  it('there is no static URL to a stored file', async () => {
    const version = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: docId } });
    for (const url of [`/uploads/${version.storageKey}`, `/${version.storageKey}`, `/api/v1/${version.storageKey}`, `/documents/${version.storageKey}`]) {
      const r = await request(app).get(url);
      expect([401, 404]).toContain(r.status);
      expect(r.headers['content-type'] ?? '').not.toContain('application/pdf');
    }
  });
});

describe('authorization and download', () => {
  it('the owner downloads their EMPLOYEE_PRIVATE contract; a colleague, their manager and an executive cannot; HR (ALL scope) can', async () => {
    const own = await as(emp, 'get', `${D}/${docId}/download`);
    expect(own.status).toBe(200);
    expect(own.headers['content-disposition']).toMatch(/^attachment; filename="Contract EMP003 \(signed\).pdf"/);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(own.body).length || own.text.length).toBeGreaterThan(0);
    expect(err(await as(emp2, 'get', `${D}/${docId}/download`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(mgr, 'get', `${D}/${docId}/download`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(mgr, 'get', `${D}/${docId}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(otherMgr, 'get', `${D}/${docId}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(exec, 'get', `${D}/${docId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'get', `${D}/${docId}/download`))).toBe('200');
    const inline = await as(emp, 'get', `${D}/${docId}/download?inline=1`);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    const audits = await prisma.auditLog.findMany({ where: { action: 'DOWNLOAD_DOCUMENT', recordId: docId } });
    expect(audits.length).toBe(3);
    expect(JSON.stringify(audits.map((a) => a.newValue))).not.toMatch(/documents\/[0-9a-f]{2}\//);
  });

  it('My documents lists the employee’s own only; a PUBLIC_INTERNAL document is visible to the team’s manager, HR_CONFIDENTIAL to HR only', async () => {
    const mine = await as(emp, 'get', `${D}/my`);
    expect(mine.body.data.map((d: { id: string }) => d.id)).toEqual([docId]);
    expect((await as(emp2, 'get', `${D}/my`)).body.data).toEqual([]);
    const pub = (await upload(hrAdmin, D, { title: 'Team handbook', categoryId: trainingCat, ownerEmployeeId: employees.EMP003, classification: 'PUBLIC_INTERNAL' }, PDF, 'handbook.pdf')).body.data;
    expect(err(await as(mgr, 'get', `${D}/${pub.id}/download`))).toBe('200');
    expect(err(await as(otherMgr, 'get', `${D}/${pub.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    const conf = (await upload(hrAdmin, D, { title: 'Investigation note', categoryId: trainingCat, ownerEmployeeId: employees.EMP003, classification: 'HR_CONFIDENTIAL' }, PDF, 'note.pdf')).body.data;
    expect(err(await as(emp, 'get', `${D}/${conf.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(mgr, 'get', `${D}/${conf.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(hr, 'get', `${D}/${conf.id}`))).toBe('200');
    expect((await as(emp, 'get', `${D}/my`)).body.data.map((d: { id: string }) => d.id).sort()).toEqual([docId, pub.id].sort());
  });

  it('a PAYROLL-scoped document needs payroll authority even for HR; RESTRICTED needs documents.manage plus the linked module', async () => {
    await prisma.rolePermission.deleteMany({ where: { role: { code: 'HR' }, permission: { code: 'payroll.manage' } } });
    const hrNoPayroll = await loginAs(app, 'hr@doc.local', PW);
    const pay = (await upload(hrAdmin, D, { title: 'Tax certificate', categoryId: payrollCat, ownerEmployeeId: employees.EMP003, classification: 'EMPLOYEE_PRIVATE' }, PDF, 'tax.pdf')).body.data;
    expect(err(await as(hrNoPayroll, 'get', `${D}/${pay.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(emp, 'get', `${D}/${pay.id}/download`))).toBe('200'); // the employee's own tax certificate
    expect(err(await as(mgr, 'get', `${D}/${pay.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    const restricted = (await upload(hrAdmin, D, { title: 'Board memo', categoryId: trainingCat, classification: 'RESTRICTED' }, PDF, 'memo.pdf')).body.data;
    expect(err(await as(hrNoPayroll, 'get', `${D}/${restricted.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(hrAdmin, 'get', `${D}/${restricted.id}/download`))).toBe('200');
    // Linking the RESTRICTED memo to an ER case: HR admin (has ER manage) may; afterwards ER authority is required too.
    expect(err(await as(hrAdmin, 'post', `${D}/${restricted.id}/links`).send({ entityType: 'EMPLOYEE_RELATION_CASE', entityId: caseId }))).toBe('201');
    await prisma.rolePermission.deleteMany({ where: { role: { code: 'HR_ADMIN' }, permission: { code: 'employee_relations.view' } } });
    await prisma.rolePermission.deleteMany({ where: { role: { code: 'HR_ADMIN' }, permission: { code: 'employee_relations.manage' } } });
    const hrAdminNoEr = await loginAs(app, 'hradmin@doc.local', PW);
    expect(err(await as(hrAdminNoEr, 'get', `${D}/${restricted.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(hrAdminNoEr, 'post', `${D}/${restricted.id}/links`).send({ entityType: 'EMPLOYEE_RELATION_CASE', entityId: caseId }))).toBe('403 FORBIDDEN');
  });
});

describe('versions, links, archive', () => {
  it('a corrected upload is v2; v1 is retained and still downloadable; concurrent uploads settle on one current version', async () => {
    const v2 = await upload(hrAdmin, `${D}/${docId}/versions`, { note: 'Corrected start date' }, Buffer.concat([PDF, Buffer.from('v2')]), 'contract-v2.pdf');
    expect(err(v2)).toBe('201');
    expect(v2.body.data.currentVersion.versionNumber).toBe(2);
    expect(v2.body.data.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    const v1 = v2.body.data.versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
    expect(err(await as(emp, 'get', `${D}/${docId}/download?versionId=${v1.id}`))).toBe('200');
    expect(v1.sha256).not.toBe(v2.body.data.currentVersion.sha256);
    const race = await Promise.all([3, 4, 5].map((n) => upload(hrAdmin, `${D}/${docId}/versions`, {}, Buffer.concat([PDF, Buffer.from(`v${n}`)]), `contract-${n}.pdf`)));
    expect(race.every((r) => r.status === 201)).toBe(true);
    const versions = await prisma.documentVersion.findMany({ where: { documentId: docId }, orderBy: { versionNumber: 'asc' } });
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3, 4, 5]);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.currentVersionId).toBe(versions[4]!.id);
    expect(new Set(versions.map((v) => v.storageKey)).size).toBe(5);
    for (const v of versions) expect(await documentStorage().exists(v.storageKey)).toBe(true);
  });

  it('links need the owning module’s authority, validate the target, and do not widen access to the target', async () => {
    expect(err(await as(mgr, 'post', `${D}/${docId}/links`).send({ entityType: 'TRAINING_ENROLLMENT', entityId: enrollmentId }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${D}/${docId}/links`).send({ entityType: 'TRAINING_ENROLLMENT', entityId: 'nope' }))).toBe('404 ENROLLMENT_NOT_FOUND');
    expect(err(await as(hrAdmin, 'post', `${D}/${docId}/links`).send({ entityType: 'employees', entityId: enrollmentId }))).toBe('400 VALIDATION_ERROR');
    const cert = (await upload(hrAdmin, D, { title: 'SQL basics certificate', categoryId: trainingCat, ownerEmployeeId: employees.EMP003 }, PDF, 'cert.pdf')).body.data;
    const linked = await as(hrAdmin, 'post', `${D}/${cert.id}/links`).send({ entityType: 'TRAINING_ENROLLMENT', entityId: enrollmentId, relationType: 'CERTIFICATE' });
    expect(err(linked)).toBe('201');
    expect(linked.body.data.links[0]).toMatchObject({ entityType: 'TRAINING_ENROLLMENT', entityId: enrollmentId });
    expect(err(await as(hrAdmin, 'post', `${D}/${cert.id}/links`).send({ entityType: 'TRAINING_ENROLLMENT', entityId: enrollmentId }))).toBe('409 DOCUMENT_LINK_EXISTS');
    const byEntity = await as(hrAdmin, 'get', `${D}?entityType=TRAINING_ENROLLMENT&entityId=${enrollmentId}`);
    expect(byEntity.body.data.map((d: { id: string }) => d.id)).toEqual([cert.id]);
    expect(err(await as(emp, 'get', `${D}/${cert.id}/download`))).toBe('200'); // own certificate; training authority waived for the owner
    expect(err(await as(emp2, 'get', `${D}/${cert.id}`))).toBe('404 DOCUMENT_NOT_FOUND');
    expect(err(await as(emp2, 'get', `/api/v1/training/enrollments/${enrollmentId}`))).not.toBe('200'); // the link changed nothing about the enrollment
    expect((await prisma.trainingEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } })).status).toBe('COMPLETED');
    expect(err(await as(hrAdmin, 'delete', `${D}/${cert.id}/links/${linked.body.data.links[0].id}`))).toBe('200');
  });

  it('archive keeps metadata and every version, hides the document by default, and there is no delete', async () => {
    const before = await prisma.documentVersion.count({ where: { documentId: docId } });
    expect((await as(hrAdmin, 'post', `${D}/${docId}/archive`)).body.data.status).toBe('ARCHIVED');
    expect(await prisma.documentVersion.count({ where: { documentId: docId } })).toBe(before);
    expect((await as(emp, 'get', `${D}/my`)).body.data.map((d: { id: string }) => d.id)).not.toContain(docId);
    expect((await as(hrAdmin, 'get', `${D}?ownerEmployeeId=${employees.EMP003}`)).body.data.map((d: { id: string }) => d.id)).not.toContain(docId);
    expect((await as(hrAdmin, 'get', `${D}?ownerEmployeeId=${employees.EMP003}&status=ARCHIVED`)).body.data.map((d: { id: string }) => d.id)).toContain(docId);
    expect(err(await as(hrAdmin, 'get', `${D}/${docId}`))).toBe('200');
    expect((await as(hrAdmin, 'delete', `${D}/${docId}`)).status).toBe(404);
    expect(err(await upload(hrAdmin, `${D}/${docId}/versions`, {}, PDF, 'late.pdf'))).toBe('409 DOCUMENT_ARCHIVED');
    const expired = (await upload(hrAdmin, D, { title: 'Old permit', categoryId: trainingCat, ownerEmployeeId: employees.EMP003, expiryDate: '2020-01-01' }, PDF, 'permit.pdf')).body.data;
    expect(expired.expiryState).toBe('EXPIRED');
    expect((await as(hrAdmin, 'get', `${D}?expiry=EXPIRED`)).body.data.map((d: { id: string }) => d.id)).toContain(expired.id);
  });

  it('readiness reports document storage', async () => {
    const r = await request(app).get('/api/v1/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.data.documentStorage).toBe('ok');
  });
});
