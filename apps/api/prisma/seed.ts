/**
 * Seed — idempotent (safe to re-run).
 *  1. permissions + roles + role_permissions from @hr/shared (source of truth)
 *  2. admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (local dev only, never hardcoded)
 *  3. sample organization structure + employees (only when the tables are empty)
 */
import { PrismaClient } from '@prisma/client';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, ROLES } from '@hr/shared';
import { env } from '../src/config/env';
import { hashPassword } from '../src/lib/password';

const prisma = new PrismaClient();

async function seedRolesAndPermissions() {
  for (const p of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { module: p.module, description: p.description },
      create: { code: p.code, module: p.module, description: p.description },
    });
  }
  const permissions = await prisma.permission.findMany();
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const r of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, dataScope: r.dataScope, isSystem: true },
      create: { code: r.code, name: r.name, description: r.description, dataScope: r.dataScope, isSystem: true },
    });
    // Only ADD missing permissions; never remove ones an admin granted via the Roles page.
    await prisma.rolePermission.createMany({
      data: r.permissions.map((code) => ({ roleId: role.id, permissionId: idByCode.get(code)! })),
    }).catch(async () => {
      for (const code of r.permissions) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId: idByCode.get(code)! } },
          update: {},
          create: { roleId: role.id, permissionId: idByCode.get(code)! },
        });
      }
    });
  }
  console.log(`✓ ${PERMISSION_DEFINITIONS.length} permissions, ${ROLE_DEFINITIONS.length} roles`);
}

async function seedAdmin() {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    console.log('- SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set → skipping admin user');
    return;
  }
  if (env.isProduction) {
    console.log('- production environment → skipping admin seed (create admins through the app)');
    return;
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { code: ROLES.SYSTEM_ADMIN } });
  const existing = await prisma.user.findUnique({ where: { email: env.SEED_ADMIN_EMAIL } });
  if (existing) {
    console.log(`- admin ${env.SEED_ADMIN_EMAIL} already exists → skipped`);
    return;
  }
  await prisma.user.create({
    data: {
      email: env.SEED_ADMIN_EMAIL,
      passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
      isActive: true,
      userRoles: { create: { roleId: role.id } },
    },
  });
  console.log(`✓ admin user ${env.SEED_ADMIN_EMAIL} (SYSTEM_ADMIN)`);
}

async function seedSampleOrganization() {
  if ((await prisma.organization.count()) > 0) {
    console.log('- organization data exists → skipping sample org');
    return;
  }

  const org = await prisma.organization.create({ data: { code: 'HQ', name: 'Head Office' } });

  const dept = async (code: string, name: string, parentId?: string) =>
    prisma.department.create({ data: { organizationId: org.id, code, name, parentId } });

  const exec = await dept('EXEC', 'Executive Office');
  const sales = await dept('SALES', 'Sales');
  const marketing = await dept('MKT', 'Marketing');
  const data = await dept('DATA', 'Data');

  const job = async (code: string, title: string, level: number) => prisma.job.create({ data: { code, title, level } });
  const jCeo = await job('CEO', 'Chief Executive Officer', 10);
  const jManager = await job('MGR', 'Manager', 5);
  const jSenior = await job('SR', 'Senior Officer', 3);
  const jOfficer = await job('OFF', 'Officer', 2);

  const pos = async (departmentId: string, jobId: string, code: string, title: string) =>
    prisma.position.create({ data: { departmentId, jobId, code, title } });
  const pCeo = await pos(exec.id, jCeo.id, 'POS-CEO', 'CEO');
  const pSalesMgr = await pos(sales.id, jManager.id, 'POS-SALES-MGR', 'Sales Manager');
  const pSalesExec = await pos(sales.id, jOfficer.id, 'POS-SALES-EXEC', 'Sales Executive');
  const pMktMgr = await pos(marketing.id, jManager.id, 'POS-MKT-MGR', 'Marketing Manager');
  const pDataMgr = await pos(data.id, jManager.id, 'POS-DATA-MGR', 'Data Manager');
  const pDataAnalyst = await pos(data.id, jSenior.id, 'POS-DATA-ANALYST', 'Data Analyst');
  const pDataEng = await pos(data.id, jSenior.id, 'POS-DATA-ENG', 'Data Engineer');

  type Seed = { code: string; first: string; last: string; nick?: string; positionId: string; departmentId: string; managerCode?: string; hired: string };
  const people: Seed[] = [
    { code: 'EMP001', first: 'Somchai', last: 'Prasert', nick: 'Chai', positionId: pCeo.id, departmentId: exec.id, hired: '2018-01-15' },
    { code: 'EMP002', first: 'Nattaya', last: 'Wong', nick: 'Nat', positionId: pSalesMgr.id, departmentId: sales.id, managerCode: 'EMP001', hired: '2019-03-01' },
    { code: 'EMP003', first: 'Peerapat', last: 'Chan', nick: 'Pete', positionId: pSalesExec.id, departmentId: sales.id, managerCode: 'EMP002', hired: '2021-06-14' },
    { code: 'EMP004', first: 'Kanya', last: 'Srisuk', nick: 'Kan', positionId: pSalesExec.id, departmentId: sales.id, managerCode: 'EMP002', hired: '2022-09-05' },
    { code: 'EMP005', first: 'Anan', last: 'Boonmee', positionId: pMktMgr.id, departmentId: marketing.id, managerCode: 'EMP001', hired: '2020-02-10' },
    { code: 'EMP006', first: 'Siriporn', last: 'Thong', nick: 'Siri', positionId: pDataMgr.id, departmentId: data.id, managerCode: 'EMP001', hired: '2019-11-20' },
    { code: 'EMP007', first: 'Thanawat', last: 'Meesuk', positionId: pDataAnalyst.id, departmentId: data.id, managerCode: 'EMP006', hired: '2023-01-09' },
    { code: 'EMP008', first: 'Pim', last: 'Rattana', positionId: pDataEng.id, departmentId: data.id, managerCode: 'EMP006', hired: '2024-04-01' },
  ];

  const idByCode = new Map<string, string>();
  for (const p of people) {
    const hireDate = new Date(p.hired);
    const managerId = p.managerCode ? idByCode.get(p.managerCode) : undefined;
    const emp = await prisma.employee.create({
      data: {
        employeeCode: p.code,
        firstName: p.first,
        lastName: p.last,
        nickname: p.nick,
        email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@company.local`,
        hireDate,
        organizationId: org.id,
        departmentId: p.departmentId,
        positionId: p.positionId,
        managerId,
        positionHistory: { create: { positionId: p.positionId, departmentId: p.departmentId, startDate: hireDate } },
        managerHistory: managerId ? { create: { managerId, startDate: hireDate } } : undefined,
      },
    });
    idByCode.set(p.code, emp.id);
  }
  await prisma.department.update({ where: { id: sales.id }, data: { headEmployeeId: idByCode.get('EMP002') } });
  await prisma.department.update({ where: { id: marketing.id }, data: { headEmployeeId: idByCode.get('EMP005') } });
  await prisma.department.update({ where: { id: data.id }, data: { headEmployeeId: idByCode.get('EMP006') } });

  console.log(`✓ sample organization: 1 org, 4 departments, 7 positions, ${people.length} employees`);
}

async function main() {
  await seedRolesAndPermissions();
  await seedAdmin();
  await seedSampleOrganization();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
