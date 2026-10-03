# Portfolio demo — ขึ้นเว็บให้คนทดลองใช้

**ข้อมูลตัวอย่างเท่านั้น ห้ามใส่ข้อมูลพนักงานจริง** — นี่คือเดโมสำหรับ portfolio ไม่ใช่การติดตั้งจริง (ดู
[release-candidate-acceptance.md](release-candidate-acceptance.md) สำหรับการใช้งานจริง)

| ส่วน | บริการ (ฟรี) | ไฟล์ |
|---|---|---|
| หน้าเว็บ | Vercel | `vercel.json` |
| API | Render (Web Service, free) | `render.yaml` |
| ฐานข้อมูล | Neon (Postgres, free) | — |

ผู้ชมเปิดแค่ URL ของ Vercel — Vercel ส่ง `/api/*` ต่อไปที่ Render ให้ จึงเป็นเว็บเดียวกัน (cookie / CSRF ทำงานปกติ)
Render ฟรีจะ "หลับ" เมื่อไม่มีคนใช้ ครั้งแรกที่เปิดอาจรอ ~30–50 วินาที

## 1. Neon — ฐานข้อมูล

1. สมัคร https://neon.tech → New project (region: Singapore) → คัดลอก **connection string** (มี `?sslmode=require`)
2. สร้างตารางและข้อมูลตัวอย่างจากเครื่องเรา (ในโฟลเดอร์ `apps/api`) — ตั้งรหัสใหม่สำหรับเดโม **ห้ามใช้รหัสเดียวกับเครื่อง dev**:

```bash
cd apps/api
DATABASE_URL='<neon connection string>' npx prisma migrate deploy
NODE_ENV=development DATABASE_URL='<neon connection string>' \
  SEED_ADMIN_PASSWORD='<รหัส admin ใหม่ ≥12 ตัว>' SEED_DEMO_PASSWORD='<รหัสเดโม ≥12 ตัว>' npm run db:seed
```

ค่าที่ใส่บน command line มีผลเหนือ `apps/api/.env` (ไม่ถูกเขียนทับ) ได้บัญชีเดโม `hradmin@company.local`,
`hr@`, `executive@`, `manager@`, `employee@company.local` (รหัส = `SEED_DEMO_PASSWORD`) และ `admin@company.local`
(System Admin — **อย่าแจกบัญชีนี้**)

## 2. Render — API

1. สมัคร https://render.com → New → **Blueprint** → เลือก repo `PIM-DATA/hr-platform` (ใช้ `render.yaml`)
2. ใส่ค่าที่ถาม: `DATABASE_URL` = connection string ของ Neon; `CORS_ORIGIN` และ `PUBLIC_APP_URL` =
   `https://<ชื่อแอป>.vercel.app` (ถ้ายังไม่รู้ ใส่ชื่อที่จะตั้งใน Vercel ไว้ก่อน แล้วแก้ทีหลังได้)
3. รอ deploy เสร็จ → เปิด `https://<service>.onrender.com/api/v1/health/live` ต้องได้ `"status":"ok"`
4. **ห้ามตั้ง** `SEED_DEMO_PASSWORD` บน Render (production จะไม่ยอม start)

## 3. Vercel — หน้าเว็บ

1. แก้ `vercel.json` บรรทัด `REPLACE-WITH-YOUR-RENDER-SERVICE` เป็นชื่อ service ของ Render → commit → push
2. สมัคร https://vercel.com → Add New Project → import `PIM-DATA/hr-platform` → **Root Directory = (ราก repo)**
   ค่า build อ่านจาก `vercel.json` เอง → Deploy
3. ถ้าชื่อ `*.vercel.app` ที่ได้ไม่ตรงกับที่ใส่ใน Render ข้อ 2 → แก้ `CORS_ORIGIN` / `PUBLIC_APP_URL` ใน Render ให้ตรง

## 4. ตรวจ

เปิด `https://<ชื่อแอป>.vercel.app` → login `employee@company.local` / `manager@company.local` / `hradmin@company.local`
ด้วยรหัสเดโม ถ้า login แล้วเด้งออกหรือได้ 403 ให้ตรวจว่า `CORS_ORIGIN` ใน Render ตรงกับ URL ที่เปิดทุกตัวอักษร (https,
ไม่มี `/` ท้าย)

## 5. ข้อความแนะนำสำหรับผู้ชม (ใส่ใน README / portfolio)

> **Live demo:** https://<ชื่อแอป>.vercel.app (ครั้งแรกรอโหลด ~30 วินาที)
> บัญชีทดลอง: `employee@company.local`, `manager@company.local`, `hradmin@company.local` — รหัส `<รหัสเดโม>`
> ข้อมูลทั้งหมดเป็นข้อมูลสมมติ และอาจถูกรีเซ็ตเป็นระยะ

## 6. ปิดไว้ในเดโม / ข้อจำกัด

- **เอกสาร (upload/download)** ปิด (`DOCUMENTS_ENABLED=false`) — Render ฟรีไม่มีดิสก์ถาวร
- **Copilot** ปิด
- ผู้ชมแก้ข้อมูลได้ (เป็นเดโม) — อยากล้างให้เหมือนเดิม: ลบ project/branch ใน Neon แล้วทำข้อ 1 ใหม่
- ไม่มี backup / monitoring (ไม่จำเป็นสำหรับข้อมูลสมมติ)
- ถ้า login บ่อยแล้วโดนจำกัด (rate limit) ทุกคนพร้อมกัน แปลว่า `TRUST_PROXY` ไม่ตรงกับจำนวน proxy — ลอง `1` หรือ `3`
