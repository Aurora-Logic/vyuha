/**
 * Fills one organisation with believable data in every module, so a person can
 * open each screen and see it working rather than see an empty state.
 *
 * **Separate from `seed.ts` on purpose.** That one runs against the real
 * database during deployment -- `DEPLOY-CHECKLIST` §3 calls it, and
 * `DEPLOYMENT` documents exactly what it creates. Adding fictional parties and
 * invented invoices to it would mean the production seed could produce them by
 * somebody forgetting a flag, which is the failure the `--with-example-people`
 * flag already exists to prevent. This is a development tool and lives apart
 * from the thing deployment depends on.
 *
 * Everything here is obviously synthetic: no real customer, no real GSTIN, no
 * real employee. Amounts are plausible for switchgear distribution so the
 * receivables screens read like the business rather than like lorem.
 *
 * Deterministic. The same run produces the same data, so a screenshot taken
 * today matches the one taken tomorrow and a bug found on "Nashik Switchgear
 * Traders" is findable again.
 */
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

/** Mulberry32. Seeded so re-runs are identical; not for anything security-facing. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260822);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const between = (lo: number, hi: number): number => Math.floor(rand() * (hi - lo + 1)) + lo;
const money = (lo: number, hi: number): string => (between(lo * 100, hi * 100) / 100).toFixed(2);

/** `n` days before today, as a DATE literal. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ fixtures

const CUSTOMERS = [
  'Nashik Switchgear Traders', 'Godavari Electricals', 'Satpur Industrial Supplies',
  'Ambad MIDC Contractors', 'Deolali Power Systems', 'Panchavati Electric Works',
  'Sinnar Automation Pvt Ltd', 'Igatpuri Cables and Controls', 'Trimbak Engineering Stores',
  'Malegaon Distribution Co', 'Ozar Aerospace Components', 'Dindori Agro Pumps',
] as const;

const VENDORS = [
  'Bharat Contactor Industries', 'Western Cable Corporation', 'Pune Enclosure Works',
  'Mumbai Relay House', 'Aurangabad Busbar Supplies', 'Nashik Fastener Depot',
] as const;

const ITEMS = [
  ['MCB 6A SP C-Curve', 'Electrical', 'Nos', 18, 145, 96],
  ['MCB 16A SP C-Curve', 'Electrical', 'Nos', 18, 158, 104],
  ['MCB 32A DP C-Curve', 'Electrical', 'Nos', 18, 412, 271],
  ['MCCB 63A 3P 25kA', 'Electrical', 'Nos', 18, 4850, 3190],
  ['MCCB 100A 3P 36kA', 'Electrical', 'Nos', 18, 7400, 4870],
  ['RCCB 40A 30mA DP', 'Electrical', 'Nos', 18, 2260, 1490],
  ['Contactor 9A 3P 240V', 'Electrical', 'Nos', 18, 1180, 780],
  ['Contactor 25A 3P 240V', 'Electrical', 'Nos', 18, 2340, 1540],
  ['Overload Relay 4-6A', 'Electrical', 'Nos', 18, 1420, 935],
  ['Distribution Board 8-Way', 'Electrical', 'Nos', 18, 3150, 2070],
  ['Distribution Board 16-Way', 'Electrical', 'Nos', 18, 5600, 3690],
  ['Enclosure 400x300x200 IP65', 'Electrical', 'Nos', 18, 4200, 2760],
  ['PVC Cable 1.5sqmm 90m', 'Cables', 'Coil', 18, 1980, 1300],
  ['PVC Cable 2.5sqmm 90m', 'Cables', 'Coil', 18, 3120, 2050],
  ['PVC Cable 4sqmm 90m', 'Cables', 'Coil', 18, 4870, 3200],
  ['Armoured Cable 4C 6sqmm', 'Cables', 'Mtr', 18, 320, 210],
  ['Control Cable 7C 1.5sqmm', 'Cables', 'Mtr', 18, 185, 122],
  ['Earthing Strip 25x3mm', 'Cables', 'Mtr', 18, 240, 158],
  ['Cable Gland 20mm Brass', 'Cables', 'Nos', 18, 85, 56],
  ['Cable Lug 16sqmm', 'Cables', 'Nos', 18, 22, 14],
  ['Ethernet Switch 8-Port', 'Networking', 'Nos', 18, 3400, 2240],
  ['CAT6 Cable Box 305m', 'Networking', 'Box', 18, 6800, 4480],
  ['Patch Panel 24-Port', 'Networking', 'Nos', 18, 2900, 1910],
  ['RJ45 Connector Pack 100', 'Networking', 'Pack', 18, 410, 270],
] as const;

const CONTACT_NAMES = [
  'Rohit Deshmukh', 'Sneha Kulkarni', 'Amit Pawar', 'Priya Jadhav', 'Nilesh Shinde',
  'Kavita Bhosale', 'Sandeep Wagh', 'Manasi Gaikwad', 'Rahul Patil', 'Vaishali More',
  'Ganesh Sonawane', 'Anjali Thorat', 'Prashant Kale', 'Rupali Chavan',
] as const;

const DESIGNATIONS = [
  'Purchase Manager', 'Site Engineer', 'Proprietor', 'Project Lead',
  'Accounts Head', 'Store Incharge', 'Director',
] as const;

const STAGES = [
  ['Enquiry', 10, false, false], ['Quoted', 30, false, false],
  ['Negotiation', 60, false, false], ['Won', 100, true, false], ['Lost', 0, false, true],
] as const;

/** DEFAULT_RETURN_REASONS from the returns contract, restated so the seeder
 *  does not import an app module. */
const RETURN_REASONS = [
  'Damaged in transit', 'Wrong item', 'Wrong quantity',
  'Quality rejection', 'Customer cancelled', 'Warranty',
] as const;

const BOARD_COLUMNS = [['To do', false], ['In progress', false], ['Blocked', false], ['Done', true]] as const;

const TASK_TITLES = [
  'Call back about the MCCB quotation', 'Site visit at Ambad MIDC', 'Send revised rates for cables',
  'Chase the pending purchase order', 'Collect payment against invoice', 'Arrange sample enclosure',
  'Follow up on the tender document', 'Confirm dispatch schedule', 'Reconcile the last GRN',
  'Prepare panel layout drawing', 'Check stock before committing', 'Renew the annual rate contract',
  'Meet the new MIDC contractor', 'Share the IS certification', 'Update the credit limit request',
] as const;

export interface DemoReport {
  readonly [table: string]: number;
}

export async function seedDemoData(pool: Pool, orgId: string): Promise<DemoReport> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await fill(client, orgId);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fill(db: PoolClient, orgId: string): Promise<DemoReport> {
  const count: Record<string, number> = {};
  const bump = (table: string, n = 1): void => {
    count[table] = (count[table] ?? 0) + n;
  };

  // The administrator owns everything created here, so every record has a real
  // actor and the "owner" columns are not left null on screens that show them.
  const owner = (
    await db.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [orgId],
    )
  ).rows[0]?.id;
  if (owner === undefined) throw new Error('No user in that organisation. Run pnpm db:seed first.');

  /*
   * `owner_id` and `assignee_id` are employee references, not user ones -- a
   * deal belongs to a salesperson, and a salesperson is an employee record
   * whether or not they have a login. Every live employee is used in rotation
   * so ownership varies across the demo; with only the administrator seeded
   * that collapses to one name, which is honest rather than wrong. Run
   * `pnpm db:seed --with-example-people` first for a fuller cast.
   */
  const staff = (
    await db.query<{ id: string }>(
      `SELECT id FROM employees WHERE org_id = $1 AND deleted_at IS NULL ORDER BY employee_code LIMIT 25`,
      [orgId],
    )
  ).rows.map((row) => row.id);
  if (staff.length === 0) throw new Error('No employee in that organisation. Run pnpm db:seed first.');
  const staffAt = (n: number): string => staff[n % staff.length] as string;

  /**
   * Whether a section has already been filled for this organisation.
   *
   * Sections skip rather than top up, and that is the safer default: running
   * this twice should not double the ledger, and an ageing report built on two
   * copies of every invoice is wrong in a way nobody would question because
   * the numbers still add up. Empty the table to regenerate a section.
   */
  const already = async (table: string): Promise<boolean> =>
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE org_id = $1`, [orgId],
      )
    ).rows[0]?.n !== '0';

  // ---------------------------------------------------------------- masters
  /*
   * Parties and items are a Tally projection, so they need a connection to
   * hang off -- `parties.connection_id` is NOT NULL by design (REQ-R-01). The
   * connection is marked as never having heartbeated, which is honest: no
   * agent is running, and the sync screens should show it as down rather than
   * pretend a Tally is attached to a laptop.
   */
  const existingConnection = (
    await db.query<{ id: string }>(
      `SELECT id FROM integration_connections WHERE org_id = $1 AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
      [orgId],
    )
  ).rows[0]?.id;

  let connectionId: string;
  if (existingConnection === undefined) {
    connectionId = randomUUID();
    await db.query(
      `INSERT INTO integration_connections (id, org_id, system, name, status, company_name, created_by)
       VALUES ($1,$2,'TALLY','Demo company (no agent attached)','DISCONNECTED','GC Communication (demo)',$3)`,
      [connectionId, orgId, owner],
    );
    bump('integration_connections');
  } else {
    connectionId = existingConnection;
  }

  const partyIds = new Map<string, string>();
  /*
   * Guarded like every other section rather than left to ON CONFLICT. There is
   * no unique index on (org_id, name) -- parties are a Tally projection and the
   * sync engine keys them by its own identifier -- so an unqualified ON CONFLICT
   * DO NOTHING had nothing to conflict against and every run inserted a second
   * Godavari Electricals under a fresh id. Four runs left 75 rows for 21 names.
   */
  const seedParties = !(await already('parties'));
  for (const [index, name] of seedParties ? [...CUSTOMERS, ...VENDORS].entries() : []) {
    const isCustomer = index < CUSTOMERS.length;
    const id = randomUUID();
    partyIds.set(name, id);
    await db.query(
      `INSERT INTO parties (id, org_id, connection_id, name, parent_group, gstin, address,
         credit_limit, credit_days, opening_balance, email, phone, last_pulled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
      [
        id, orgId, connectionId, name,
        isCustomer ? 'Sundry Debtors' : 'Sundry Creditors',
        // Deliberately not a valid checksum: nobody should be able to paste a
        // demo GSTIN into a real return.
        `27DEMO${String(1000 + index)}Z${String(index % 10)}`,
        `${pick(['Satpur', 'Ambad', 'Sinnar', 'Panchavati'])}, Nashik, Maharashtra`,
        isCustomer ? money(200000, 1500000) : null,
        isCustomer ? pick([15, 30, 45, 60]) : null,
        money(0, 80000),
        `accounts@${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`,
        `+9198${String(between(10000000, 99999999))}`,
      ],
    );
    bump('parties');
  }

  for (const row of (
    await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM parties WHERE org_id = $1 ORDER BY created_at`, [orgId],
    )
  ).rows) {
    partyIds.set(row.name, row.id);
  }

  const itemIds = new Map<string, string>();
  const seedItems = !(await already('stock_items'));
  for (const [name, group, unit, gst, sale, cost] of seedItems ? ITEMS : []) {
    const id = randomUUID();
    itemIds.set(name, id);
    await db.query(
      `INSERT INTO stock_items (id, org_id, connection_id, name, unit, parent_group, gst_rate,
         closing_qty, sale_price, cost_price, last_pulled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [id, orgId, connectionId, name, unit, group, gst, between(0, 400), sale, cost],
    );
    bump('stock_items');
  }

  for (const row of (
    await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM stock_items WHERE org_id = $1 ORDER BY created_at`, [orgId],
    )
  ).rows) {
    itemIds.set(row.name, row.id);
  }


  // --------------------------------------------------------------- vouchers
  /*
   * Twelve months of Sales and Receipts, because the receivables screens are
   * the ones that need history to say anything. Payment analysis (REQ-Y-04)
   * states outright that one financial year is noise, and ageing needs bills
   * spread across the buckets rather than all landing in 0-30.
   *
   * Receipts are deliberately not one-per-invoice: some customers pay late,
   * some part-pay, two do not pay at all. An ageing report where every bucket
   * but the first is empty demonstrates nothing.
   */
  if (!(await already('vouchers'))) {
  const customerNames = [...CUSTOMERS];
  let voucherNo = 1000;
  for (let month = 11; month >= 0; month -= 1) {
    const invoicesThisMonth = between(6, 11);
    for (let n = 0; n < invoicesThisMonth; n += 1) {
      const party = pick(customerNames);
      const partyId = partyIds.get(party) ?? null;
      const date = daysAgo(month * 30 + between(0, 27));
      const lineCount = between(1, 4);

      const lines: { item: string; qty: number; rate: number; amount: number }[] = [];
      for (let l = 0; l < lineCount; l += 1) {
        const [itemName, , , , sale] = pick(ITEMS);
        const qty = between(1, 25);
        lines.push({ item: itemName, qty, rate: sale, amount: qty * sale });
      }
      const total = lines.reduce((sum, line) => sum + line.amount, 0);

      voucherNo += 1;
      const voucherId = randomUUID();
      await db.query(
        `INSERT INTO vouchers (id, org_id, connection_id, voucher_date, voucher_type,
           voucher_number, party_name, party_id, amount, narration, last_pulled_at)
         VALUES ($1,$2,$3,$4,'Sales',$5,$6,$7,$8,$9, now())`,
        [voucherId, orgId, connectionId, date, `GC/${String(voucherNo)}`, party, partyId,
         total.toFixed(2), 'Supply of switchgear items'],
      );
      bump('vouchers');

      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, stock_item_name,
             stock_item_id, actual_qty, billed_qty, rate, amount)
           VALUES ($1,$2,$3,$4,'inventory',$5,$6,$7,$8,$9,$10)`,
          [randomUUID(), orgId, voucherId, lineNo, line.item, itemIds.get(line.item) ?? null,
           line.qty, line.qty, line.rate.toFixed(2), line.amount.toFixed(2)],
        );
        bump('voucher_lines');
      }

      /*
       * Who paid, and when. The shape matters more than the numbers: three in
       * five settle, one in five part-pays, one in five has not paid at all --
       * which is what puts rows in the 31-60, 61-90 and 90+ ageing buckets and
       * gives payment analysis a spread of days-to-pay to average.
       */
      const roll = rand();
      if (roll < 0.6 || (roll < 0.8 && month > 1)) {
        const part = roll < 0.6 ? 1 : 0.4;
        voucherNo += 1;
        const receiptId = randomUUID();
        const paidAfter = between(5, 75);
        await db.query(
          `INSERT INTO vouchers (id, org_id, connection_id, voucher_date, voucher_type,
             voucher_number, party_name, party_id, amount, narration, last_pulled_at)
           VALUES ($1,$2,$3,$4,'Receipt',$5,$6,$7,$8,$9, now())`,
          [receiptId, orgId, connectionId,
           daysAgo(Math.max(0, month * 30 - paidAfter)), `RCT/${String(voucherNo)}`,
           party, partyId, (total * part).toFixed(2),
           part < 1 ? 'Part payment against invoice' : 'Payment against invoice'],
        );
        bump('vouchers');
        await db.query(
          `INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, ledger_name, amount)
           VALUES ($1,$2,$3,1,'ledger',$4,$5)`,
          [randomUUID(), orgId, receiptId, party, (total * part).toFixed(2)],
        );
        bump('voucher_lines');
      }
    }
  }

  }

  // -------------------------------------------------------------------- CRM
  /*
   * Reuse the default pipeline if the organisation already has one.
   *
   * `crm_pipelines_org_default_uq` allows exactly one default per org, and it
   * is right to -- two defaults means the deal form picks whichever the
   * planner returned first. So this adopts what is there instead of insisting
   * on its own, which also makes the whole script re-runnable.
   */
  const existingPipeline = (
    await db.query<{ id: string }>(
      `SELECT id FROM crm_pipelines WHERE org_id = $1 AND is_default AND deleted_at IS NULL LIMIT 1`,
      [orgId],
    )
  ).rows[0]?.id;

  let pipelineId: string;
  if (existingPipeline === undefined) {
    pipelineId = randomUUID();
    await db.query(
      `INSERT INTO crm_pipelines (id, org_id, name, is_default, created_by) VALUES ($1,$2,$3,true,$4)`,
      [pipelineId, orgId, 'Switchgear sales', owner],
    );
    bump('crm_pipelines');
  } else {
    pipelineId = existingPipeline;
  }

  const stageIds: string[] = (
    await db.query<{ id: string }>(
      `SELECT id FROM crm_pipeline_stages WHERE org_id = $1 AND pipeline_id = $2
         AND deleted_at IS NULL ORDER BY sort_order`,
      [orgId, pipelineId],
    )
  ).rows.map((row) => row.id);

  if (stageIds.length === 0) {
    for (const [index, [name, probability, isWon, isLost]] of STAGES.entries()) {
      const id = randomUUID();
      stageIds.push(id);
      await db.query(
        `INSERT INTO crm_pipeline_stages (id, org_id, pipeline_id, name, sort_order, probability,
           is_won, is_lost, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, orgId, pipelineId, name, index + 1, probability, isWon, isLost, owner],
      );
      bump('crm_pipeline_stages');
    }
  }

  /*
   * Eight prospect companies, half of them linked to a Tally party and half
   * not. REQ-U-03 is explicit that a lead is never pushed to Tally -- a
   * prospect who never buys must not become a ledger -- so a demo where every
   * company already has a party would hide the case the requirement is about.
   */
  const companyIds: string[] = [];
  const contactIds: string[] = [];

  if (!(await already('crm_companies'))) {
    for (const [index, name] of CUSTOMERS.slice(0, 8).entries()) {
      const id = randomUUID();
      companyIds.push(id);
      await db.query(
        `INSERT INTO crm_companies (id, org_id, name, phone, email, city, owner_id, party_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, orgId, name, `+9198${String(between(10000000, 99999999))}`,
         `hello@${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`, 'Nashik', staffAt(index),
         index % 2 === 0 ? (partyIds.get(name) ?? null) : null, owner],
      );
      bump('crm_companies');
    }
  }

  if (!(await already('crm_contacts'))) {
    for (const [index, name] of CONTACT_NAMES.entries()) {
      const id = randomUUID();
      contactIds.push(id);
      const phone = `+9197${String(between(10000000, 99999999))}`;
      await db.query(
        `INSERT INTO crm_contacts (id, org_id, name, phone, phone_key, email, designation,
           company_id, owner_id, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, orgId, name, phone, phone.replace(/\D/gu, ''),
         `${name.split(' ')[0]?.toLowerCase() ?? 'contact'}@example.com`, pick(DESIGNATIONS),
         companyIds[index % Math.max(companyIds.length, 1)] ?? null, staffAt(index),
         pick(['Referral', 'Walk-in', 'Exhibition', 'Website', 'Cold call']), owner],
      );
      bump('crm_contacts');
    }
  }


  if (companyIds.length === 0) {
    companyIds.push(
      ...(
        await db.query<{ id: string }>(
          `SELECT id FROM crm_companies WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [orgId],
        )
      ).rows.map((row) => row.id),
    );
  }
  if (contactIds.length === 0) {
    contactIds.push(
      ...(
        await db.query<{ id: string }>(
          `SELECT id FROM crm_contacts WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [orgId],
        )
      ).rows.map((row) => row.id),
    );
  }

  if (!(await already('crm_deals'))) {
  for (let n = 0; n < 14; n += 1) {
    const stageIndex = between(0, STAGES.length - 1);
    const stage = STAGES[stageIndex];
    const closed = stage?.[2] === true || stage?.[3] === true;
    await db.query(
      `INSERT INTO crm_deals (id, org_id, name, company_id, contact_id, pipeline_id, stage_id,
         value, expected_close_date, owner_id, closed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), orgId,
       `${pick(['Panel upgrade', 'Annual rate contract', 'MCC replacement', 'New line', 'DB retrofit'])} - ${pick(CUSTOMERS)}`,
       companyIds[n % companyIds.length] ?? null, contactIds[n % contactIds.length] ?? null,
       pipelineId, stageIds[stageIndex] ?? stageIds[0], money(45000, 1800000),
       daysAgo(-between(5, 90)), staffAt(n), closed ? new Date().toISOString() : null, owner],
    );
    bump('crm_deals');
  }

  }

  // ------------------------------------------------------------------ tasks
  const columnIds: string[] = (
    await db.query<{ id: string }>(
      `SELECT id FROM task_board_columns WHERE org_id = $1 AND deleted_at IS NULL ORDER BY sort_order`,
      [orgId],
    )
  ).rows.map((row) => row.id);

  if (columnIds.length === 0) {
    for (const [index, [name, isDone]] of BOARD_COLUMNS.entries()) {
      const id = randomUUID();
      columnIds.push(id);
      await db.query(
        `INSERT INTO task_board_columns (id, org_id, name, sort_order, is_done, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, orgId, name, index + 1, isDone, owner],
      );
      bump('task_board_columns');
    }
  }

  // Guarded for the same reason the masters are: nothing here has a unique key
  // to conflict against, so an ungated re-run stacks a second copy of every
  // task on the board.
  const seedTasks = !(await already('tasks'));
  for (const [index, title] of seedTasks ? TASK_TITLES.entries() : []) {
    const columnIndex = index % columnIds.length;
    const done = (
      await db.query<{ is_done: boolean }>(
        `SELECT is_done FROM task_board_columns WHERE id = $1`,
        [columnIds[columnIndex] ?? columnIds[0]],
      )
    ).rows[0]?.is_done === true;
    /*
     * A third of these hang off nothing, which is the case REQ-V-02's nullable
     * subject exists for and the one a demo that attached everything to a deal
     * would never show.
     */
    const onContact = index % 3 === 0;
    await db.query(
      `INSERT INTO tasks (id, org_id, title, description, subject_type, subject_id, subject_label,
         assignee_id, owner_id, due_date, priority, column_id, closed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), orgId, title, null,
       onContact ? 'crm_contact' : null, onContact ? (contactIds[index % contactIds.length] ?? null) : null,
       onContact ? (CONTACT_NAMES[index % CONTACT_NAMES.length] ?? null) : null,
       staffAt(index), staffAt(index + 1), daysAgo(-between(-10, 21)),
       pick(['LOW', 'MEDIUM', 'HIGH'] as const), columnIds[columnIndex] ?? columnIds[0],
       done ? new Date().toISOString() : null, owner],
    );
    bump('tasks');
  }

  // ------------------------------------------------------- sales documents
  /*
   * Estimates and sales orders across their states, because the state chip is
   * the thing worth looking at. `sync_state` is left NOT_PUSHED throughout: no
   * agent is attached, and REQ-W-06 is explicit that a document must never
   * claim to be in Tally when it is not -- the state is reported by the agent,
   * never inferred, and inventing PUSHED here would be exactly the lie that
   * requirement exists to prevent.
   */
  if (!(await already('sales_documents'))) {
  const salesStates = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONFIRMED'] as const;
  let estimateNo = 100;
  let orderNo = 500;

  for (let n = 0; n < 18; n += 1) {
    const isOrder = n % 3 === 0;
    const party = pick([...CUSTOMERS]);
    const docId = randomUUID();
    const lineCount = between(1, 4);

    const lines: { item: string; qty: number; rate: number; tax: number }[] = [];
    for (let l = 0; l < lineCount; l += 1) {
      const [itemName, , , gst, sale] = pick(ITEMS);
      lines.push({ item: itemName, qty: between(1, 30), rate: sale, tax: gst });
    }
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
    const taxTotal = lines.reduce((sum, line) => sum + (line.qty * line.rate * line.tax) / 100, 0);

    if (isOrder) orderNo += 1;
    else estimateNo += 1;

    await db.query(
      `INSERT INTO sales_documents (id, org_id, doc_type, number, status, date, valid_until,
         party_id, customer_name, owner_id, subtotal, discount_total, tax_total, grand_total,
         place_of_supply, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,'Maharashtra',$14)`,
      [docId, orgId, isOrder ? 'SALES_ORDER' : 'ESTIMATE',
       isOrder ? `SO/${String(orderNo)}` : `EST/${String(estimateNo)}`,
       isOrder ? pick(['DRAFT', 'CONFIRMED'] as const) : pick(salesStates),
       daysAgo(between(1, 120)), daysAgo(-between(5, 30)),
       partyIds.get(party) ?? null, party, staffAt(n),
       subtotal.toFixed(2), taxTotal.toFixed(2), (subtotal + taxTotal).toFixed(2), owner],
    );
    bump('sales_documents');

    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      const amount = line.qty * line.rate;
      await db.query(
        `INSERT INTO sales_document_lines (id, org_id, document_id, line_no, stock_item_id,
           description, quantity, unit, rate, discount_pct, tax_pct, amount, tax_amount, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Nos',$8,0,$9,$10,$11,$12)`,
        [randomUUID(), orgId, docId, lineNo, itemIds.get(line.item) ?? null, line.item,
         line.qty, line.rate.toFixed(2), line.tax, amount.toFixed(2),
         ((amount * line.tax) / 100).toFixed(2), owner],
      );
      bump('sales_document_lines');
    }
  }

  }

  // ---------------------------------------------------- purchase documents
  if (!(await already('purchase_orders'))) {
  let poNo = 200;
  for (let n = 0; n < 9; n += 1) {
    const vendor = pick([...VENDORS]);
    const poId = randomUUID();
    poNo += 1;
    const lineCount = between(1, 3);

    const lines: { item: string; qty: number; rate: number; tax: number }[] = [];
    for (let l = 0; l < lineCount; l += 1) {
      const [itemName, , , gst, , cost] = pick(ITEMS);
      lines.push({ item: itemName, qty: between(10, 120), rate: cost, tax: gst });
    }
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
    const taxTotal = lines.reduce((sum, line) => sum + (line.qty * line.rate * line.tax) / 100, 0);

    await db.query(
      `INSERT INTO purchase_orders (id, org_id, number, status, date, party_id, vendor_name,
         expected_date, owner_id, subtotal, tax_total, grand_total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [poId, orgId, `PO/${String(poNo)}`,
       pick(['DRAFT', 'CONFIRMED', 'PENDING_APPROVAL'] as const),
       daysAgo(between(1, 90)), partyIds.get(vendor) ?? null, vendor,
       daysAgo(-between(3, 40)), staffAt(n),
       subtotal.toFixed(2), taxTotal.toFixed(2), (subtotal + taxTotal).toFixed(2), owner],
    );
    bump('purchase_orders');

    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      const amount = line.qty * line.rate;
      // Partly received on some lines, so the open-purchase-order view
      // (REQ-X-05) has ordered-versus-received to show rather than two columns
      // that always match.
      const received = rand() < 0.4 ? between(0, line.qty) : 0;
      await db.query(
        `INSERT INTO purchase_order_lines (id, org_id, purchase_order_id, line_no, stock_item_id,
           description, quantity, unit, rate, tax_pct, amount, tax_amount, received_qty, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Nos',$8,$9,$10,$11,$12,$13)`,
        [randomUUID(), orgId, poId, lineNo, itemIds.get(line.item) ?? null, line.item,
         line.qty, line.rate.toFixed(2), line.tax, amount.toFixed(2),
         ((amount * line.tax) / 100).toFixed(2), received, owner],
      );
      bump('purchase_order_lines');
    }
  }

  }

  // ------------------------------------------------------------- attendance
  /*
   * Sixty days of muster for everyone, so the reports have something to
   * aggregate and Team attendance is not one row.
   *
   * Written straight into `attendance_days` rather than by punching and
   * letting the engine compute. That is a deliberate shortcut with one rule
   * attached: the row and its punches must agree. A day marked PRESENT with no
   * punch behind it is the exact inconsistency the punch audit report exists to
   * surface, and seeding one would make a real bug look like demo data. So
   * PRESENT and HALF_DAY days get their two punches, and ABSENT days get none.
   *
   * Weekends are WEEKLY_OFF and holidays are skipped entirely, because the day
   * engine would never produce a PRESENT on a date the holiday calendar owns
   * and a demo that did would misrepresent the product.
   */
  const holidayDates = new Set(
    (
      await db.query<{ date: string }>(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM holidays WHERE org_id = $1`,
        [orgId],
      )
    ).rows.map((row) => row.date),
  );

  const shiftId = (
    await db.query<{ id: string }>(
      `SELECT id FROM shifts WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [orgId],
    )
  ).rows[0]?.id ?? null;

  const DAYS_OF_MUSTER = 60;
  // `attendance_days` has a unique key and quietly skips a re-run, but the
  // punches and leave requests hanging off it do not -- so the section is
  // gated as a whole rather than relying on the one table that is protected.
  const seedMuster = !(await already('attendance_days'));
  for (const [personIndex, employeeId] of seedMuster ? staff.entries() : []) {
    for (let back = 1; back <= DAYS_OF_MUSTER; back += 1) {
      const date = daysAgo(back);
      if (holidayDates.has(date)) continue;

      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const isWeekend = weekday === 0;

      // Enough variety that every status appears somewhere, weighted so the
      // muster still reads like a working month rather than a fault log.
      let status: string;
      if (isWeekend) status = 'WEEKLY_OFF';
      else {
        const roll = rand();
        if (roll < 0.82) status = 'PRESENT';
        else if (roll < 0.88) status = 'HALF_DAY';
        else if (roll < 0.94) status = 'ON_LEAVE';
        else if (roll < 0.97) status = 'ON_DUTY';
        else status = 'ABSENT';
      }

      const worked = status === 'PRESENT' ? between(465, 585)
        : status === 'HALF_DAY' ? between(200, 260)
        : status === 'ON_DUTY' ? between(420, 540)
        : 0;
      const late = status === 'PRESENT' && rand() < 0.18 ? between(3, 42) : 0;
      const early = status === 'PRESENT' && rand() < 0.1 ? between(5, 35) : 0;

      const dayId = randomUUID();
      await db.query(
        `INSERT INTO attendance_days (id, org_id, employee_id, date, shift_id, status,
           worked_minutes, break_minutes, ot_minutes, late_minutes, early_exit_minutes, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT DO NOTHING`,
        [dayId, orgId, employeeId, date, shiftId, status, worked,
         worked > 0 ? 30 : 0, worked > 540 ? worked - 540 : 0, late, early],
      );
      bump('attendance_days');

      if (worked > 0) {
        const inHour = 9 + Math.floor(late / 60);
        const inMinute = late % 60;
        for (const [type, hh, mm] of [
          ['IN', inHour, inMinute],
          ['OUT', inHour + Math.floor(worked / 60), (inMinute + (worked % 60)) % 60],
        ] as const) {
          await db.query(
            // `idempotency_key` is NOT NULL (REQ-D-11) so a retried request
            // cannot create a second punch. Seeded rows need one too, and it
            // has to be unique per punch rather than per run.
            `INSERT INTO punches (id, org_id, employee_id, punch_type, server_time, client_time,
               attendance_date, source, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$5,$6,'WEB',$7)
             ON CONFLICT DO NOTHING`,
            [randomUUID(), orgId, employeeId, type,
             `${date} ${String(Math.min(hh, 23)).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`,
             date, `demo-${String(employeeId)}-${date}-${type}`],
          );
          bump('punches');
        }
      }
    }

    // A few leave requests per person, in different states, so the approvals
    // inbox and My leave both have something to show.
    if (personIndex % 3 === 0) {
      const leaveTypeId = (
        await db.query<{ id: string }>(
          `SELECT id FROM leave_types WHERE org_id = $1 AND deleted_at IS NULL ORDER BY random() LIMIT 1`,
          [orgId],
        )
      ).rows[0]?.id;
      if (leaveTypeId !== undefined) {
        const from = between(2, 50);
        await db.query(
          `INSERT INTO leave_requests (id, org_id, employee_id, leave_type_id, from_date, to_date,
             total_days, reason, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [randomUUID(), orgId, employeeId, leaveTypeId, daysAgo(from), daysAgo(from - 1), 2,
           pick(['Family function', 'Medical', 'Personal work', 'Out of station']),
           pick(['PENDING', 'APPROVED', 'APPROVED', 'REJECTED'] as const), owner],
        );
        bump('leave_requests');
      }
    }
  }

  // ------------------------------------------------------ bill allocations
  /*
   * Derived from the vouchers already seeded rather than invented alongside
   * them, so the two agree by construction: every Sales voucher raises exactly
   * one bill for its own amount, and receipts settle those bills oldest first.
   *
   * FIFO because that is what bill-wise settlement does when nobody says
   * otherwise, and because it is what makes the ageing report interesting --
   * a party who part-pays leaves the *oldest* bill open, which is precisely
   * the case a net balance hides.
   *
   * Runs against whatever vouchers exist, so it works whether they were seeded
   * a moment ago or last week.
   */
  if (!(await already('bill_allocations'))) {
    const sales = (
      await db.query<{ id: string; party_id: string | null; party_name: string; voucher_number: string; voucher_date: string; amount: string }>(
        `SELECT id, party_id, party_name, voucher_number, to_char(voucher_date,'YYYY-MM-DD') AS voucher_date, amount
           FROM vouchers WHERE org_id = $1 AND voucher_type = 'Sales' AND NOT is_cancelled
          ORDER BY voucher_date, voucher_number`,
        [orgId],
      )
    ).rows;

    const receipts = (
      await db.query<{ id: string; party_id: string | null; voucher_date: string; amount: string }>(
        `SELECT id, party_id, to_char(voucher_date,'YYYY-MM-DD') AS voucher_date, amount
           FROM vouchers WHERE org_id = $1 AND voucher_type = 'Receipt' AND NOT is_cancelled
          ORDER BY voucher_date`,
        [orgId],
      )
    ).rows;

    // Credit days come from the party, so a bill's due date is the terms the
    // customer actually has rather than a constant.
    const creditDays = new Map<string, number>(
      (
        await db.query<{ id: string; credit_days: number | null }>(
          `SELECT id, credit_days FROM parties WHERE org_id = $1`, [orgId],
        )
      ).rows.map((row) => [row.id, row.credit_days ?? 30]),
    );

    /** Open bills per party, oldest first, as receipts are applied to them. */
    const open = new Map<string, { billName: string; billDate: string; left: number }[]>();

    for (const voucher of sales) {
      if (voucher.party_id === null) continue;
      const amount = Number(voucher.amount);
      const days = creditDays.get(voucher.party_id) ?? 30;
      const due = new Date(`${voucher.voucher_date}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + days);

      await db.query(
        `INSERT INTO bill_allocations (id, org_id, connection_id, voucher_id, party_id, party_name,
           bill_name, ref_type, bill_date, due_date, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8,$9,$10)`,
        [randomUUID(), orgId, connectionId, voucher.id, voucher.party_id, voucher.party_name,
         voucher.voucher_number, voucher.voucher_date, due.toISOString().slice(0, 10), amount.toFixed(2)],
      );
      bump('bill_allocations');

      const bills = open.get(voucher.party_id) ?? [];
      bills.push({ billName: voucher.voucher_number, billDate: voucher.voucher_date, left: amount });
      open.set(voucher.party_id, bills);
    }

    for (const receipt of receipts) {
      if (receipt.party_id === null) continue;
      let remaining = Number(receipt.amount);
      const bills = (open.get(receipt.party_id) ?? []).filter((bill) => bill.left > 0.005);

      for (const bill of bills) {
        if (remaining <= 0.005) break;
        // A receipt can only ever settle what is on the bill; the surplus
        // moves to the next one. Without this a large payment would drive one
        // bill negative and the ageing sum would be wrong in both directions.
        const applied = Math.min(bill.left, remaining);
        bill.left -= applied;
        remaining -= applied;

        await db.query(
          `INSERT INTO bill_allocations (id, org_id, connection_id, voucher_id, party_id, party_name,
             bill_name, ref_type, bill_date, amount)
           VALUES ($1,$2,$3,$4,$5,(SELECT party_name FROM vouchers WHERE id = $4),$6,'against',$7,$8)`,
          [randomUUID(), orgId, connectionId, receipt.id, receipt.party_id,
           bill.billName, bill.billDate, (-applied).toFixed(2)],
        );
        bump('bill_allocations');
      }

      // Money with no bill left to put it against is exactly what `on_account`
      // is for, and the ageing report excludes it on purpose -- there is no
      // date to age from.
      if (remaining > 0.005) {
        await db.query(
          `INSERT INTO bill_allocations (id, org_id, connection_id, voucher_id, party_id, party_name,
             bill_name, ref_type, amount)
           VALUES ($1,$2,$3,$4,$5,(SELECT party_name FROM vouchers WHERE id = $4),'On account','on_account',$6)`,
          [randomUUID(), orgId, connectionId, receipt.id, receipt.party_id, (-remaining).toFixed(2)],
        );
        bump('bill_allocations');
      }
    }
  }

  // -------------------------------------------------------- promises to pay
  /*
   * Built from the bills the ageing report already shows as open, not from a
   * fresh set of invented amounts. A promise against a bill that does not exist
   * would make "promised versus collected" disagree with the ledger it is meant
   * to be read beside, and the disagreement would look like a bug in the report
   * rather than a bug in the fixture.
   *
   * The mix of states is deliberate: the collections screens are only worth
   * looking at when some promises were kept, some part-kept, some broken
   * outright, and some are still ahead of their date.
   */
  if (!(await already('promises_to_pay'))) {
    const openBills = (
      await db.query<{ party_id: string; bill_name: string; outstanding: string }>(
        `SELECT party_id, bill_name, round(sum(amount), 2)::text AS outstanding
           FROM bill_allocations
          WHERE org_id = $1 AND party_id IS NOT NULL AND ref_type IN ('new', 'against')
          GROUP BY party_id, bill_name HAVING round(sum(amount), 2) > 0
          ORDER BY party_id, bill_name`,
        [orgId],
      )
    ).rows;

    // One promise covers up to three of a party's open bills, which is how a
    // collector takes one -- against a balance, not against a single invoice.
    const byParty = new Map<string, typeof openBills>();
    for (const bill of openBills) {
      const held = byParty.get(bill.party_id) ?? [];
      held.push(bill);
      byParty.set(bill.party_id, held);
    }

    let promiseNo = 0;
    for (const [partyId, bills] of byParty) {
      const covered = bills.slice(0, between(1, 3));
      const amount = covered.reduce((sum, b) => sum + Number(b.outstanding), 0);
      if (amount <= 0) continue;

      // Half fall due in the past, so there is something to have been kept or
      // broken; the rest are open and still ahead of their date.
      const daysOut = promiseNo % 2 === 0 ? -between(3, 55) : between(2, 21);
      const promised = daysAgo(-daysOut);
      const roll = promiseNo % 6;
      const state = daysOut > 0 ? 'open' : roll < 3 ? 'kept' : roll < 5 ? 'partially_kept' : 'broken';
      const received =
        state === 'kept' ? amount : state === 'partially_kept' ? amount * (between(30, 80) / 100) : 0;

      await db.query(
        `INSERT INTO promises_to_pay (id, org_id, party_id, amount, promised_date, bills, taken_by,
           taken_on, notes, state, received_amount, received_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [randomUUID(), orgId, partyId, amount.toFixed(2), promised, covered.map((b) => b.bill_name),
         staffAt(promiseNo), daysAgo(Math.abs(daysOut) + between(2, 10)),
         pick(['Confirmed on the phone with accounts.', 'Cheque to be handed over at the site visit.',
               'Waiting on their own customer to release funds.', 'Agreed after the rate dispute was settled.']),
         state, received.toFixed(2), received > 0 ? promised : null, owner],
      );
      bump('promises_to_pay');
      promiseNo += 1;
    }
  }

  // ---------------------------------------------------------------- returns
  /*
   * Returns only read as a rate, so they are spread across items that were
   * actually sold -- a return of something never invoiced gives "return rate by
   * item" a denominator of zero and a row that says nothing. Damaged goods are
   * scrapped and everything else restocked, which is what makes the disposition
   * worth a column.
   */
  if (!(await already('sales_returns'))) {
    const sold = (
      await db.query<{ stock_item_name: string; qty: string }>(
        // billed_qty is text on the projection because Tally sends it that way,
        // and it sometimes arrives with the unit attached (1 NOS), so the digits
        // have to be pulled out before it will add up.
        `SELECT l.stock_item_name,
                sum(nullif(regexp_replace(l.billed_qty, '[^0-9.]', '', 'g'), '')::numeric)::text AS qty
           FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
          WHERE l.org_id = $1 AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
            AND l.stock_item_name IS NOT NULL AND l.billed_qty IS NOT NULL
          GROUP BY l.stock_item_name
         HAVING sum(nullif(regexp_replace(l.billed_qty, '[^0-9.]', '', 'g'), '')::numeric) > 0
          ORDER BY 2 DESC LIMIT 10`,
        [orgId],
      )
    ).rows;

    for (let n = 0; n < 14 && sold.length > 0; n += 1) {
      const customer = pick(CUSTOMERS);
      const returnId = randomUUID();
      const state = n % 7 === 6 ? 'cancelled' : n % 3 === 0 ? 'credited' : 'awaiting_credit_note';

      await db.query(
        `INSERT INTO sales_returns (id, org_id, number, state, party_id, customer_name, received_on,
           received_by, notes, replacement_charge, cancelled_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [returnId, orgId, `SR/${String(1001 + n)}`, state, partyIds.get(customer) ?? null, customer,
         daysAgo(between(2, 120)), staffAt(n),
         n % 4 === 0 ? 'Collected by our own vehicle on the return leg.' : null,
         n % 5 === 0 ? 'free' : 'chargeable',
         state === 'cancelled' ? 'Customer kept the goods after a rate adjustment.' : null, owner],
      );
      bump('sales_returns');

      for (let lineNo = 1; lineNo <= between(1, 3); lineNo += 1) {
        const item = sold[(n + lineNo) % sold.length];
        if (item === undefined) continue;
        const reason = RETURN_REASONS[(n + lineNo) % RETURN_REASONS.length] as string;
        const damaged = reason === 'Damaged in transit' || reason === 'Quality rejection';
        // A tenth of what was sold, so the rate lands somewhere a person would
        // investigate rather than at 0.01% or at 90%.
        const qty = Math.max(1, Math.round((Number(item.qty) / 10) * (between(20, 90) / 100)));

        await db.query(
          `INSERT INTO sales_return_lines (id, org_id, return_id, line_no, stock_item_id, description,
             unit, quantity, reason, reason_note, condition, disposition, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [randomUUID(), orgId, returnId, lineNo, itemIds.get(item.stock_item_name) ?? null,
           item.stock_item_name, 'Nos', String(qty), reason,
           damaged ? 'Photographed at the gate before it was taken in.' : null,
           damaged ? 'damaged' : lineNo === 1 ? 'sealed' : 'opened',
           damaged ? 'scrap' : 'restock', owner],
        );
        bump('sales_return_lines');
      }
    }
  }

  // ------------------------------------------------------------- duplicates
  /*
   * Real pairs out of the masters already seeded, so opening a cluster shows two
   * records a person can compare rather than two names that resolve to nothing.
   * The bands matter more than the count: the detector's screens sort by
   * confidence, and a fixture with everything at 0.99 never exercises them.
   */
  if (!(await already('duplicate_clusters'))) {
    const pairs: ReadonlyArray<readonly [string, readonly string[], number, string]> = [
      ['party', CUSTOMERS.slice(0, 2), 0.97, 'gstin,name'],
      ['party', CUSTOMERS.slice(2, 4), 0.88, 'name,phone'],
      ['party', VENDORS.slice(0, 2), 0.79, 'name'],
      ['stock_item', ITEMS.slice(0, 2).map((i) => i[0]), 0.96, 'alias,name'],
      ['stock_item', ITEMS.slice(2, 4).map((i) => i[0]), 0.83, 'name,unit'],
    ];

    for (const [entityType, names, confidence, matched] of pairs) {
      const lookup = entityType === 'party' ? partyIds : itemIds;
      const members = names.map((n) => lookup.get(n)).filter((id): id is string => id !== undefined);
      if (members.length < 2) continue;

      const clusterId = randomUUID();
      await db.query(
        `INSERT INTO duplicate_clusters (id, org_id, entity_type, confidence, matched_fields, state,
           signature, member_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [clusterId, orgId, entityType, confidence.toFixed(3), matched,
         confidence >= 0.95 ? 'sent_to_tally' : 'open', [...members].sort().join(':'), members.length],
      );
      bump('duplicate_clusters');

      for (const entityId of members) {
        await db.query(
          `INSERT INTO duplicate_cluster_members (id, org_id, cluster_id, entity_type, entity_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), orgId, clusterId, entityType, entityId],
        );
        bump('duplicate_cluster_members');
      }
    }
  }

  return count;
}
