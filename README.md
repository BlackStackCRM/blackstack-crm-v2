# BlackStack CRM V2

Full-stack CRM application built with Node.js, Express, SQLite, and Vanilla JavaScript.

## Architecture

```
Frontend (Vanilla JS + Tailwind)
    ↓
REST API (Express)
    ↓
Services (Business Logic)
    ↓
Repositories (Data Access)
    ↓
SQLite Database
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Run database migrations
npm run migrate

# Seed default data (optional)
npm run seed

# Start development server
npm run dev
```

## Project Structure

```
server/
├── app.js                    # Express app setup
├── config/                   # Configuration
├── middleware/               # Auth, RBAC, validation
├── routes/                   # API route definitions
├── controllers/              # Request handlers
├── services/                 # Business logic
├── repositories/             # Data access layer
├── models/                   # Data models
├── validators/               # Input validation
├── auth/                     # Authentication & authorization
├── database/                 # Migrations, seeds, connection
└── utils/                    # Utilities

public/
├── index.html                # SPA shell
├── css/
├── js/
│   ├── api/                  # API client
│   ├── components/           # Reusable UI components
│   ├── pages/                # Page controllers
│   └── app.js                # Main app initialization
└── assets/

tests/
├── unit/
├── integration/
└── security/
```

## Features

- Contact & Organization Management
- Sales Pipeline & Deal Tracking
- Invoice & Payment Processing
- Workflow Automation
- Reporting & Analytics
- Role-Based Access Control
- Audit Logging
- Responsive Design

## Tech Stack

- **Backend**: Node.js, Express, better-sqlite3
- **Frontend**: Vanilla JavaScript, Tailwind CSS
- **Database**: SQLite with WAL mode
- **Auth**: JWT tokens
- **Validation**: Zod
