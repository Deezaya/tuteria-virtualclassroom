# Tuteria Virtual Classroom

The backend is built with Node.js, TypeScript, Fastify, and Prisma. The product requirements are in `docs/`.

## Backend setup

Requirements: Node.js and npm.

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL`, a random `JWT_SECRET` of at least 32 characters, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD` in `backend/.env`. Never commit `.env` or share its contents.

Generate Prisma Client and create/apply the development migration:

```powershell
npm run prisma:generate
npm run prisma:migrate
npm run seed
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

The API health check is `GET http://localhost:3000/health`. Interactive API documentation is available at `http://localhost:3000/docs`.

## Spaces and invites

After applying the `add_spaces` migration, use the Swagger page to create and manage spaces:

- From `backend/`, run `npx prisma migrate dev --name add_spaces` to apply the migration, then `npm run build` to generate Prisma Client and compile the API.
- Admins and tutors can create spaces and search their own spaces; admins can list all spaces.
- Space creators and admins can rename spaces and generate invite or observer links. Generating a link rotates its token, so a previously generated link stops working.
- Only admins can delete spaces.
- Invite links contain a one-time-visible random token. Only a SHA-256 hash is stored in the database. The `/invites/resolve` endpoint accepts the token in a POST body and returns the space id and name; it also updates `lastUsedAt`.
- Link responses are relative paths (`/join?token=...` and `/observe?token=...`) for the frontend to append to its own origin.

## Testing authentication

Open `http://localhost:3000/docs` in your browser and use Swagger UI to try the endpoints. Start with `POST /auth/login` and enter the admin email and password used when seeding. The response sets an HTTP-only cookie; because Swagger is served from the same API origin, the browser sends that cookie with `/auth/me` and `/users`.

Then try `GET /auth/me`, create a tutor with `POST /users`, and use `POST /auth/logout`. After logout, `GET /auth/me` should return 401. To check incorrect-password handling, submit `POST /auth/login` with a wrong password; it should return 401 with the same generic message used for an unknown email.

You can also use the VS Code REST Client extension. Keep its cookie jar enabled for the same login and logout flow.

To confirm the table exists, connect to the configured PostgreSQL database and run:

```sql
SELECT to_regclass('public.users');
```

The result should be `users`. Alternatively, use `npm run prisma:studio` and inspect the `User` model.
