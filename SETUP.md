# Backend Setup Guide

## Prerequisites

- Node.js installed
- PostgreSQL database (Railway or local)
- Frontend deployed and accessible

## Setup Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Update `.env` file with your actual values:

```env
# Get this from Railway PostgreSQL service
DATABASE_URL=postgresql://username:password@host:port/database

# Server port
PORT=3000

# Set to production for deployment
NODE_ENV=production

# Add your frontend domain
ALLOWED_ORIGINS=https://arisan.gr,https://www.arisan.gr,http://localhost:3000
```

### 3. Initialize Database

Make a POST request to initialize the database table:

```bash
curl -X POST http://localhost:3000/api/init-db
```

Or if you already have a contacts table without the `name` column, run the migration:

```bash
curl -X POST http://localhost:3000/api/migrate-add-name
```

### 4. Start the Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## API Endpoints

### Health Check
```
GET /api/health
```
Returns server status and timestamp.

### Database Test
```
GET /api/db-test
```
Tests database connectivity and returns PostgreSQL version.

### Initialize Database
```
POST /api/init-db
```
Creates the contacts table if it doesn't exist.

### Migrate Database (Add Name Column)
```
POST /api/migrate-add-name
```
Adds the `name` column to existing contacts table. Existing records will have name set to "Anonymous".

### Submit Contact Form
```
POST /api/contact
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "message": "Hello, I'd like to discuss..."
}
```

**Success Response (200):**
```json
{
  "success": true,
  "contact": {
    "id": 1,
    "name": "John Doe",
    "email": "john@example.com",
    "message": "Hello...",
    "created_at": "2026-02-14T..."
  }
}
```

**Error Response (400/500):**
```json
{
  "success": false,
  "error": "Error message"
}
```

### Get All Contacts
```
GET /api/contacts
```
Returns all contact form submissions.

## Deployment to Railway

1. **Create Railway Project**
   - Go to [Railway](https://railway.app)
   - Create new project
   - Add PostgreSQL service

2. **Configure Environment Variables**
   - Add `DATABASE_URL` (automatically set by Railway PostgreSQL)
   - Add `NODE_ENV=production`
   - Add `ALLOWED_ORIGINS=https://arisan.gr` (your frontend domain)
   - Add `PORT` (Railway will set this automatically)

3. **Deploy**
   - Connect your GitHub repository
   - Railway will auto-deploy on push
   - Or deploy manually: `railway up`

4. **Initialize Database**
   ```bash
   curl -X POST https://api.arisan.gr/api/init-db
   ```

## Testing Integration

1. **Test Backend Health**
   ```bash
   curl https://api.arisan.gr/api/health
   ```

2. **Test Contact Form from Frontend**
   - Visit your frontend: https://arisan.gr
   - Fill out the contact form
   - Submit and check for success message

3. **Verify Submission**
   ```bash
   curl https://api.arisan.gr/api/contacts
   ```

## Troubleshooting

### CORS Errors
- Ensure `ALLOWED_ORIGINS` includes your frontend domain
- Check browser console for specific error messages
- In development, add `http://localhost:3000` to allowed origins

### Database Connection Errors
- Verify `DATABASE_URL` is correct
- Check Railway PostgreSQL service is running
- Test connection: `curl https://api.arisan.gr/api/db-test`

### Missing Name Column
- Run migration: `POST /api/migrate-add-name`
- Or reinitialize database (will drop existing data): `POST /api/init-db`

## Security Notes

- Never commit `.env` file to version control
- Use strong database passwords
- Keep `ALLOWED_ORIGINS` restricted to your domains only
- Enable SSL/HTTPS in production
- Consider adding rate limiting for production use
