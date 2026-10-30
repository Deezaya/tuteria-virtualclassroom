# Tuteria Virtual Classroom

The backend is built with Node.js, TypeScript, Fastify, and Prisma. The product requirements are in `docs/`.

## Backend setup

Requirements: Node.js and npm.

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL` in `backend/.env` to your PostgreSQL connection string. Never commit `.env` or share its contents.

Generate Prisma Client and create/apply the development migration:

```powershell
npm run prisma:generate
npm run prisma:migrate
```

Run the API in development:

```powershell
npm run dev
```

Build and start the API:

```powershell
npm run build
npm start
```

The API health check is `GET http://localhost:3000/health`.

To confirm the table exists, connect to the configured PostgreSQL database and run:

```sql
SELECT to_regclass('public.users');
```

The result should be `users`. Alternatively, use `npm run prisma:studio` and inspect the `User` model.
