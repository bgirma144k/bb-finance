require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { PlaidApi, Configuration, PlaidEnvironments, Products, CountryCode } = require('plaid');
const path = require('path');

const app = express();

// ─── ALLOWED USERS (only these 3 emails can log in) ───────────────────────
const ALLOWED_EMAILS = [
  'blutz.518@gmail.com',
  'bgirma144k@gmail.com',
  'protectingfamilies1st@gmail.com'
];

// ─── PLAID CLIENT ───────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ─── IN-MEMORY TOKEN STORE (use a DB in production) ─────────────────────────
// Maps userId -> { accessToken, itemId }
const userTokens = {};

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bb-finance-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ─── PASSPORT GOOGLE STRATEGY ────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value?.toLowerCase();

  if (!ALLOWED_EMAILS.includes(email)) {
    return done(null, false, { message: 'Access denied. This app is private.' });
  }

  const user = {
    id: profile.id,
    email,
    name: profile.displayName,
    firstName: profile.name?.givenName,
    photo: profile.photos?.[0]?.value,
  };

  return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Login page
app.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Google OAuth
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=access_denied' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Dashboard page (protected)
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ─── API: Current user ────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    name: req.user.name,
    firstName: req.user.firstName,
    email: req.user.email,
    photo: req.user.photo,
  });
});

// ─── PLAID: Create Link Token ─────────────────────────────────────────────────
app.post('/api/plaid/create-link-token', requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.user.id },
      client_name: 'B&B Finance',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Plaid link token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// ─── PLAID: Exchange Public Token ─────────────────────────────────────────────
app.post('/api/plaid/exchange-token', requireAuth, async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;

    if (!userTokens[req.user.id]) userTokens[req.user.id] = [];
    userTokens[req.user.id].push({ access_token, item_id, institution_name });

    res.json({ success: true, institution: institution_name });
  } catch (err) {
    console.error('Token exchange error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// ─── PLAID: Get All Accounts ──────────────────────────────────────────────────
app.get('/api/plaid/accounts', requireAuth, async (req, res) => {
  try {
    const tokens = userTokens[req.user.id] || [];
    if (tokens.length === 0) return res.json({ accounts: [] });

    const allAccounts = [];
    for (const { access_token, institution_name } of tokens) {
      const response = await plaidClient.accountsGet({ access_token });
      const accounts = response.data.accounts.map(a => ({
        ...a,
        institution: institution_name
      }));
      allAccounts.push(...accounts);
    }

    res.json({ accounts: allAccounts });
  } catch (err) {
    console.error('Accounts error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// ─── PLAID: Get Transactions ──────────────────────────────────────────────────
app.get('/api/plaid/transactions', requireAuth, async (req, res) => {
  try {
    const tokens = userTokens[req.user.id] || [];
    if (tokens.length === 0) return res.json({ transactions: [] });

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const allTransactions = [];
    for (const { access_token } of tokens) {
      const response = await plaidClient.transactionsGet({
        access_token,
        start_date: startDate,
        end_date: endDate,
      });
      allTransactions.push(...response.data.transactions);
    }

    // Sort newest first
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTransactions.slice(0, 50) });
  } catch (err) {
    console.error('Transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ─── PLAID: Get Balances ──────────────────────────────────────────────────────
app.get('/api/plaid/balances', requireAuth, async (req, res) => {
  try {
    const tokens = userTokens[req.user.id] || [];
    if (tokens.length === 0) return res.json({ accounts: [] });

    const allBalances = [];
    for (const { access_token, institution_name } of tokens) {
      const response = await plaidClient.accountsBalanceGet({ access_token });
      const accounts = response.data.accounts.map(a => ({
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        balance: a.balances.current,
        available: a.balances.available,
        limit: a.balances.limit,
        institution: institution_name,
        mask: a.mask,
      }));
      allBalances.push(...accounts);
    }

    res.json({ accounts: allBalances });
  } catch (err) {
    console.error('Balances error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

// ─── STATIC BUDGET DATA (from your sheet) ─────────────────────────────────────
app.get('/api/budget/static', requireAuth, (req, res) => {
  res.json({
    monthlyExpenses: [
      { category: 'Rent', amount: 1600, dueDate: '1st', type: 'Bank (BoA)' },
      { category: 'Truck', amount: 554, dueDate: '3rd', type: 'Bank (BoA)' },
      { category: 'Utilities', amount: 75, dueDate: '10th', type: 'Bank (BoA)' },
      { category: 'Student Loan', amount: 242, dueDate: '17th', type: 'Bank (BoA)' },
      { category: 'Tesla', amount: 618, dueDate: '24th', type: 'Bank (BoA)' },
      { category: 'T-Mobile', amount: 155, dueDate: '25th', type: 'Bank (BoA)' },
      { category: 'aidVantage', amount: 124.72, dueDate: '28th', type: 'Bank (BoA)' },
      { category: 'Car Wash (Brad)', amount: 20, dueDate: '19th', type: 'Credit Card (RH)' },
      { category: 'Lemonade Insurance', amount: 26.91, dueDate: '12th', type: 'Credit Card (RH)' },
      { category: 'Car Wash (Beza)', amount: 20, dueDate: '21st', type: 'Credit Card' },
      { category: 'Internet', amount: 50.26, dueDate: '25th', type: 'Credit Card (RH)' },
      { category: 'Ringy', amount: 109, dueDate: '26th', type: 'Credit Card (GSA)' },
      { category: 'iPhone', amount: 41.62, dueDate: '30th', type: 'Credit Card (GSA)' },
      { category: 'Apple Watch', amount: 35.75, dueDate: '30th', type: 'Credit Card (GSA)' },
      { category: 'F45', amount: 169, dueDate: 'Monthly', type: 'Credit Card (RH)' },
      { category: 'Lashes', amount: 100, dueDate: 'Random', type: 'Credit Card (RH)' },
      { category: 'TxTag', amount: 40, dueDate: 'Random', type: 'Credit Card (RH)' },
      { category: 'Tithe/Offering', amount: 1400, dueDate: 'Monthly', type: 'Withdraw' },
    ],
    yearlyExpenses: [
      { category: 'AMEX Gold', amount: 325, dueDate: '5/23' },
      { category: 'AMEX Platinum', amount: 895, dueDate: '7/16' },
      { category: 'AMEX Platinum 2', amount: 195, dueDate: '7/16' },
      { category: 'E&O Insurance', amount: 432, dueDate: '8/1' },
      { category: 'AMEX Blue', amount: 95, dueDate: '8/7' },
      { category: 'Venture', amount: 95, dueDate: '8/10' },
      { category: 'Zoom', amount: 156, dueDate: '8/30' },
      { category: 'Calendly', amount: 112, dueDate: '8/30' },
      { category: 'AMEX Delta', amount: 175, dueDate: '11/15' },
    ],
    income: [
      { source: 'Brad - GM', amount: 8000, type: 'Bank (BoA)' },
      { source: 'Beza - Insurance', amount: 2833.59, type: 'Bank (BoA)' },
    ],
    cards: [
      { name: 'Apple Card', balance: 86.85, dueDate: '5/30/2026', nextStatement: 77.37, thisMonth: 77.37, remainder: 9.48, useCase: 'Chargepoint (3%) + random (tap 2%), iPhone, Apple Watch' },
      { name: 'Bank of America', balance: 124.36, dueDate: '6/5/2026', nextStatement: 124.36, thisMonth: 0, remainder: 0, useCase: '3% online shopping, Tesla Sub' },
      { name: 'AMEX Platinum', balance: 5611.80, dueDate: '6/10/2026', nextStatement: 3879.84, thisMonth: 0, remainder: 1731.96, useCase: 'Airfare, hotels, rentals, HULU, Walmart, Peacock' },
      { name: 'AMEX Gold', balance: 505.34, dueDate: '6/17/2026', nextStatement: 505.34, thisMonth: 0, remainder: 0, useCase: 'Eating out (4%), carwash, Dunkin' },
      { name: 'AMEX Blue', balance: 914.95, dueDate: '6/1/2026', nextStatement: 387.60, thisMonth: 0, remainder: 527.35, useCase: 'Grocery (6%) & gas (4%)' },
      { name: 'RobinHood', balance: 5666.83, dueDate: '6/17/2026', nextStatement: 5666.83, thisMonth: 0, remainder: 0, useCase: 'Random (3% back all), Tesla Insurance, Ringy, etc.' },
      { name: 'Amazon', balance: 745.53, dueDate: '6/10/2026', nextStatement: 724.96, thisMonth: 0, remainder: 20.57, useCase: 'All Amazon (5% cashback)' },
      { name: 'Venmo', balance: 58.62, dueDate: '6/7/2026', nextStatement: 58.62, thisMonth: 0, remainder: 0, useCase: '1-3% on highest categories' },
    ]
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏦 B&B Finance running at http://localhost:${PORT}`);
  console.log(`📋 Allowed users: ${ALLOWED_EMAILS.join(', ')}\n`);
});
