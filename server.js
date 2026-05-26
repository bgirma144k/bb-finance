require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require('plaid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bb-finance-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── Plaid client ──────────────────────────────────────────────────────────────
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

// ── In-memory token store (replace with DB for production) ────────────────────
// Structure: { accessToken, itemId, institutionName, accounts: [...] }
let linkedItems = [];

// ─────────────────────────────────────────────────────────────────────────────
// INCOME TRANSACTION CLASSIFIER
//
// Any credit (money-in) to the ···2429 account that matches one of these
// patterns is treated as income. Amount from Plaid is negative for credits
// on depository accounts, so we check amount < 0 (money flowing IN).
// ─────────────────────────────────────────────────────────────────────────────

const INCOME_PAYMENT_TYPES = ['ach', 'eft'];

// Plaid transaction_type for credits into a depository account
const INCOME_TRANSACTION_TYPES = ['special', 'place']; // Plaid uses these for payroll/ACH

// Keywords in name/merchant that flag a transaction as income
const INCOME_KEYWORDS = [
  'payroll', 'direct dep', 'direct deposit', 'ach deposit', 'ach credit',
  'eft deposit', 'eft credit', 'eft payment', 'commission', 'salary',
  'wages', 'bonus', 'reimbursement', 'transfer in', 'zelle', 'venmo',
  'cashapp', 'wire transfer', 'wire deposit',
];

// Plaid personal_finance_category primary values that map to income
const INCOME_PFC_CATEGORIES = [
  'INCOME', 'TRANSFER_IN',
];

function classifyIncomeTransaction(txn) {
  // Plaid depository: negative amount = money coming IN to the account
  const isCredit = txn.amount < 0;
  if (!isCredit) return null; // outflow — not income

  const name = (txn.name || '').toLowerCase();
  const merchant = (txn.merchant_name || '').toLowerCase();
  const paymentChannel = (txn.payment_channel || '').toLowerCase();
  const paymentMeta = txn.payment_meta || {};
  const pfcPrimary = txn.personal_finance_category?.primary || '';
  const pfcDetailed = txn.personal_finance_category?.detailed || '';

  // 1. Plaid personal finance category says income or transfer-in
  if (INCOME_PFC_CATEGORIES.some(c => pfcPrimary.toUpperCase().includes(c))) {
    return labelIncomeType(name, pfcDetailed, paymentMeta);
  }

  // 2. Payment meta has ACH or EFT indicators
  const ppd = (paymentMeta.ppd_id || '').toLowerCase();
  const payeeRef = (paymentMeta.payee || '').toLowerCase();
  if (paymentMeta.payment_method) {
    const method = paymentMeta.payment_method.toLowerCase();
    if (INCOME_PAYMENT_TYPES.some(t => method.includes(t))) {
      return labelIncomeType(name, pfcDetailed, paymentMeta);
    }
  }

  // 3. Name/merchant keyword match
  const combined = `${name} ${merchant} ${payeeRef}`;
  if (INCOME_KEYWORDS.some(k => combined.includes(k))) {
    return labelIncomeType(name, pfcDetailed, paymentMeta);
  }

  return null; // not classified as income
}

function labelIncomeType(name, pfcDetailed, paymentMeta) {
  const n = name.toLowerCase();
  const d = pfcDetailed.toLowerCase();

  if (n.includes('commission')) return 'Commission';
  if (n.includes('bonus'))      return 'Bonus';
  if (n.includes('zelle') || n.includes('venmo') || n.includes('cashapp')) return 'Transfer In';
  if (n.includes('wire'))       return 'Wire Transfer';
  if (n.includes('payroll') || d.includes('payroll') || d.includes('wages')) return 'Payroll';
  if (n.includes('eft'))        return 'EFT Deposit';
  if (n.includes('ach'))        return 'ACH Deposit';
  if (n.includes('direct dep')) return 'Direct Deposit';
  return 'Income Deposit';
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT ROUTING LOGIC
//
// Income source  → "Adv Plus Banking ···2429"  (subtype: checking, last4: 2429)
// BoA credit data→ "Customized Cash Rewards Visa Signature ···0784" (last4: 0784)
// ─────────────────────────────────────────────────────────────────────────────

function identifyAccount(account) {
  const name = (account.name || '').toLowerCase();
  const official = (account.official_name || '').toLowerCase();
  const last4 = account.mask || '';
  const subtype = (account.subtype || '').toLowerCase();

  if (last4 === '2429' || name.includes('adv plus') || name.includes('advantage plus') || official.includes('adv plus')) {
    return { role: 'income', label: 'Adv Plus Banking ···2429' };
  }
  if (last4 === '0784' || name.includes('customized cash') || official.includes('customized cash rewards')) {
    return { role: 'boa_credit', label: 'Bank of America · Customized Cash Rewards ···0784' };
  }
  if (subtype === 'credit card') {
    return { role: 'credit_card', label: account.official_name || account.name };
  }
  if (subtype === 'checking' || subtype === 'savings') {
    return { role: 'bank', label: account.official_name || account.name };
  }
  return { role: 'other', label: account.official_name || account.name };
}

// ── Create Plaid Link token ───────────────────────────────────────────────────
app.post('/api/plaid/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'bb-user-001' },
      client_name: 'B&B Finance',
      products: [Products.Transactions, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// ── Exchange public token ─────────────────────────────────────────────────────
app.post('/api/plaid/exchange-token', async (req, res) => {
  const { public_token } = req.body;
  try {
    const tokenRes = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = tokenRes.data.access_token;
    const itemId = tokenRes.data.item_id;

    // Fetch accounts immediately so we can tag them
    const accountsRes = await plaidClient.accountsGet({ access_token: accessToken });
    const accounts = accountsRes.data.accounts.map(a => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      balances: a.balances,
      identity: identifyAccount(a),
    }));

    // Try to get institution name
    let institutionName = 'Unknown Bank';
    try {
      const itemRes = await plaidClient.itemGet({ access_token: accessToken });
      const instId = itemRes.data.item.institution_id;
      if (instId) {
        const instRes = await plaidClient.institutionsGetById({ institution_id: instId, country_codes: [CountryCode.Us] });
        institutionName = instRes.data.institution.name;
      }
    } catch (_) {}

    // Remove existing item for same institution (re-link)
    linkedItems = linkedItems.filter(i => i.itemId !== itemId);
    linkedItems.push({ accessToken, itemId, institutionName, accounts });

    res.json({ success: true, accounts: accounts.map(a => ({ name: a.name, mask: a.mask, role: a.identity.role })) });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// ── Get all financial data ────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  if (linkedItems.length === 0) {
    return res.json({ linked: false, accounts: [], creditCards: [], income: null, summary: null });
  }

  try {
    const allAccounts = [];
    const creditCards = [];
    let incomeAccount = null;
    let boaCreditAccount = null;

    // Refresh balances for all linked items
    for (const item of linkedItems) {
      try {
        const accountsRes = await plaidClient.accountsGet({ access_token: item.accessToken });

        for (const a of accountsRes.data.accounts) {
          const identity = identifyAccount(a);
          const enriched = {
            account_id: a.account_id,
            name: a.name,
            official_name: a.official_name,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
            balances: a.balances,
            institution: item.institutionName,
            identity,
          };
          allAccounts.push(enriched);

          if (identity.role === 'income') {
            incomeAccount = enriched;
          } else if (identity.role === 'boa_credit') {
            boaCreditAccount = enriched;
          } else if (identity.role === 'credit_card') {
            creditCards.push(enriched);
          }
        }
      } catch (itemErr) {
        console.warn(`Error fetching item ${item.itemId}:`, itemErr.message);
      }
    }

    // Try to get liabilities for credit card statement info
    const liabilitiesMap = {}; // account_id -> liability details
    for (const item of linkedItems) {
      try {
        const liabRes = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
        const creditLiabilities = liabRes.data.liabilities.credit || [];
        for (const cl of creditLiabilities) {
          liabilitiesMap[cl.account_id] = {
            last_statement_balance: cl.last_statement_balance,
            minimum_payment_amount: cl.minimum_payment_amount,
            next_payment_due_date: cl.next_payment_due_date,
            last_payment_date: cl.last_payment_date,
            last_payment_amount: cl.last_payment_amount,
            is_overdue: cl.is_overdue,
          };
        }
      } catch (_) {
        // liabilities product may not be enabled for all items
      }
    }

    // Build credit card objects with liability data merged
    const buildCreditCard = (account) => {
      const liability = liabilitiesMap[account.account_id] || {};
      return {
        account_id: account.account_id,
        name: account.name,
        official_name: account.official_name,
        mask: account.mask,
        institution: account.institution,
        label: account.identity.label,
        current_balance: account.balances.current,
        available_credit: account.balances.available,
        credit_limit: account.balances.limit,
        last_statement_balance: liability.last_statement_balance ?? null,
        minimum_payment: liability.minimum_payment_amount ?? null,
        due_date: liability.next_payment_due_date ?? null,
        last_payment_date: liability.last_payment_date ?? null,
        last_payment_amount: liability.last_payment_amount ?? null,
        is_overdue: liability.is_overdue ?? false,
      };
    };

    // BoA credit card (specifically mapped)
    const creditCardsList = [];
    if (boaCreditAccount) {
      creditCardsList.push(buildCreditCard(boaCreditAccount));
    }
    for (const cc of creditCards) {
      creditCardsList.push(buildCreditCard(cc));
    }

    // Income summary + transactions from the ···2429 account
    let incomeData = null;
    if (incomeAccount) {
      const incomeTransactions = await fetchIncomeTransactions(incomeAccount.account_id);
      const now = new Date();
      const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
      const thisMonthTxns = incomeTransactions.filter(t => t.date.startsWith(thisMonth));
      const prevMonthTxns = incomeTransactions.filter(t => t.date.startsWith(prevMonth));
      const sumAmounts = (txns) => txns.reduce((s, t) => s + Math.abs(t.amount), 0);
      incomeData = {
        label: incomeAccount.identity.label,
        institution: incomeAccount.institution,
        available_balance: incomeAccount.balances.available,
        current_balance: incomeAccount.balances.current,
        account_type: `${incomeAccount.type} / ${incomeAccount.subtype}`,
        this_month_total: sumAmounts(thisMonthTxns),
        prev_month_total: sumAmounts(prevMonthTxns),
        this_month_transactions: thisMonthTxns,
        recent_transactions: incomeTransactions.slice(0, 30),
      };
    }

    // Total card debt
    const totalDebt = creditCardsList.reduce((sum, c) => sum + (c.current_balance || 0), 0);

    res.json({
      linked: true,
      accounts: allAccounts.map(a => ({
        name: a.name,
        mask: a.mask,
        institution: a.institution,
        role: a.identity.role,
        label: a.identity.label,
        balances: a.balances,
      })),
      creditCards: creditCardsList,
      income: incomeData,
      totalDebt,
    });
  } catch (err) {
    console.error('data fetch error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch account data' });
  }
});


// ── Fetch & classify income transactions for a given account_id ──────────────
async function fetchIncomeTransactions(targetAccountId) {
  const results = [];
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const item of linkedItems) {
    try {
      const allTxns = [];
      try {
        let cursor = null;
        let hasMore = true;
        while (hasMore) {
          const syncRes = await plaidClient.transactionsSync({
            access_token: item.accessToken,
            cursor: cursor || undefined,
            count: 500,
          });
          allTxns.push(...syncRes.data.added, ...syncRes.data.modified);
          cursor = syncRes.data.next_cursor;
          hasMore = syncRes.data.has_more;
          if (allTxns.length > 2000) break;
        }
      } catch (_) {
        const getRes = await plaidClient.transactionsGet({
          access_token: item.accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { account_ids: [targetAccountId], count: 500, offset: 0 },
        });
        allTxns.push(...getRes.data.transactions);
      }

      for (const txn of allTxns) {
        if (txn.account_id !== targetAccountId) continue;
        if (txn.date < startDate || txn.date > endDate) continue;
        const incomeType = classifyIncomeTransaction(txn);
        if (!incomeType) continue;
        results.push({
          id: txn.transaction_id,
          date: txn.date,
          name: txn.name,
          merchant: txn.merchant_name || null,
          amount: Math.abs(txn.amount),
          income_type: incomeType,
          category: txn.personal_finance_category?.primary || (txn.category || [])[0] || 'Income',
          pending: txn.pending,
        });
      }
    } catch (err) {
      console.warn('fetchIncomeTransactions error:', err.message);
    }
  }
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results;
}

// ── Dedicated income transactions endpoint ────────────────────────────────────
app.get('/api/income-transactions', async (req, res) => {
  if (linkedItems.length === 0) return res.json({ linked: false, transactions: [], totals: {}, byType: {} });
  try {
    let incomeAccountId = null;
    for (const item of linkedItems) {
      for (const a of item.accounts) {
        if (a.identity.role === 'income') { incomeAccountId = a.account_id; break; }
      }
      if (incomeAccountId) break;
    }
    if (!incomeAccountId) return res.json({ linked: true, transactions: [], totals: {}, byType: {}, message: 'Income account not linked yet' });

    const transactions = await fetchIncomeTransactions(incomeAccountId);
    const totals = {};
    const byType = {};
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      totals[month] = (totals[month] || 0) + t.amount;
      byType[t.income_type] = (byType[t.income_type] || 0) + t.amount;
    }
    res.json({ linked: true, transactions, totals, byType });
  } catch (err) {
    console.error('/api/income-transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch income transactions' });
  }
});

// ── Serve dashboard ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`B&B Finance running on port ${PORT}`));
