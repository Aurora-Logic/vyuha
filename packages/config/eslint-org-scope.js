/**
 * The org-scoping invariant, as a rule the build enforces rather than a
 * convention a reviewer has to remember.
 *
 * Owner's decision, 22 Aug 2026: every tenant's data lives in one database and
 * one schema, so the only thing separating two organisations is that every
 * read and every write names `org_id`. A review found 14 repositories that did
 * not extend `ScopedRepository` and 131 hand-written `sql` blocks with no
 * literal `org_id` in them. No leak was found -- which is exactly the problem:
 * nothing would have found one, and the next person to write a query has
 * nothing telling them the rule exists.
 *
 * The table list is generated from the database: every table that HAS an
 * `org_id` column must be queried through one. It is checked against the live
 * schema by `org-scope-rule.test.ts`, so a table added later cannot quietly
 * fall outside the rule.
 */

/** Tables with an `org_id` column. Generated; see the test that pins it. */
export const ORG_SCOPED_TABLES = [
  'approval_delegations',
  'approval_requests',
  'approval_steps',
  'attendance_adjustments',
  'attendance_days',
  'attendance_period_locks',
  'audit_logs',
  'bill_allocations',
  'collector_assignments',
  'comp_off_credits',
  'consent_acceptances',
  'crm_companies',
  'crm_contacts',
  'crm_deals',
  'crm_pipeline_stages',
  'crm_pipelines',
  'custom_reports',
  'cfo_targets',
  'cfo_desk_outcomes',
  'cfo_desk_served',
  'customer_owner_map',
  'deletion_records',
  'dashboard_layouts',
  'departments',
  'designations',
  'devices',
  'dispatch_attachments',
  'dispatch_lines',
  'dispatch_notifications',
  'dispatches',
  'document_sequences',
  'duplicate_cluster_members',
  'duplicate_clusters',
  'employees',
  'export_jobs',
  'external_refs',
  'fact_receivable_snapshot',
  'fact_sales_daily',
  'files',
  'grn_lines',
  'grns',
  'holiday_calendars',
  'holidays',
  'integration_connections',
  'interest_build_state',
  'interest_daily_party',
  'interest_daily_stock',
  'interest_party_settings',
  'invitations',
  'item_settings',
  'item_vendors',
  'leave_balances',
  'leave_ledger',
  'leave_request_days',
  'leave_requests',
  'leave_types',
  'locations',
  'mfa_challenges',
  'mfa_recovery_codes',
  'mfa_trusted_devices',
  'notification_idempotency',
  'notification_preferences',
  'notifications',
  'on_duty_requests',
  'pack_record_lines',
  'pack_records',
  'parties',
  'party_managers',
  'password_resets',
  'pick_record_lines',
  'pick_records',
  'po_line_requirements',
  'portal_access_log',
  'portal_link_keys',
  'price_list_assignments',
  'price_list_entries',
  'price_list_lines',
  'price_lists',
  'procurement_requirements',
  'promises_to_pay',
  'punch_flag_reviews',
  'punches',
  'purchase_order_lines',
  'purchase_order_notifications',
  'purchase_orders',
  'regularizations',
  'reminder_notices',
  'report_schedules',
  'report_usage',
  'restricted_holiday_elections',
  'roles',
  'sales_document_lines',
  'sales_document_sequences',
  'sales_documents',
  'sales_order_invoices',
  'sales_return_attachments',
  'sales_return_credit_notes',
  'sales_return_lines',
  'sales_returns',
  'saved_views',
  'sessions',
  'settings',
  'shift_assignments',
  'shifts',
  'stock_items',
  'sync_cursors',
  'sync_exceptions',
  'sync_inbox',
  'sync_jobs',
  'sync_journal',
  'task_board_columns',
  'tasks',
  'users',
  'voucher_lines',
  'vouchers',
  'weekly_off_patterns',
];

const SCOPED_BASE = 'ScopedRepository';

/**
 * Table references in a SQL string: what follows FROM, JOIN, UPDATE or INTO.
 * Interpolations are blanked to `?` first, so `FROM ${sql.raw(t)}` and
 * `FROM (${subquery}) t` cannot be mistaken for a table name.
 */
function tablesIn(text) {
  const found = new Set();
  const pattern = /\b(?:from|join|update|into)\s+"?([a-z_][a-z0-9_]*)"?/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) found.add(match[1].toLowerCase());
  return found;
}

/** The template's own text, with every ${...} replaced by a single `?`. */
function templateText(node) {
  return node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ? ');
}

const repositoryIsOrgBound = {
  meta: {
    type: 'problem',
    docs: { description: 'A repository is bound to one organisation, so it cannot be asked for another one\'s rows.' },
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      unbound:
        '{{name}} is a repository but nothing binds it to an organisation: it neither extends {{base}} nor takes an ' +
        'OrgContext or an orgId. Every tenant shares one schema, so an unbound repository is one forgotten WHERE away ' +
        'from serving another organisation\'s rows. Take the binding in the constructor, where it cannot be omitted at ' +
        'a call site.',
    },
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);

    /** Does this constructor take an organisation, by type or by name? */
    function bindsAnOrg(node) {
      const ctor = node.body.body.find((m) => m.type === 'MethodDefinition' && m.kind === 'constructor');
      if (ctor === undefined) return false;
      return ctor.value.params.some((raw) => {
        const param = raw.type === 'TSParameterProperty' ? raw.parameter : raw;
        const name = param.type === 'Identifier' ? param.name : null;
        if (name === 'orgId' || name === 'ctx' || name === 'context') return true;
        const annotation = param.typeAnnotation?.typeAnnotation;
        const typeName =
          annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier'
            ? annotation.typeName.name
            : null;
        return typeName === 'OrgContext';
      });
    }

    return {
      ClassDeclaration(node) {
        const name = node.id?.name;
        if (name === undefined || !name.endsWith('Repository') || name === SCOPED_BASE) return;
        if (allow.has(name)) return;
        const superName =
          node.superClass?.type === 'Identifier' ? node.superClass.name
          : node.superClass?.type === 'MemberExpression' && node.superClass.property.type === 'Identifier' ? node.superClass.property.name
          : null;
        if (superName === SCOPED_BASE) return;
        if (bindsAnOrg(node)) return;
        context.report({ node: node.id ?? node, messageId: 'unbound', data: { name, base: SCOPED_BASE } });
      },
    };
  },
};

const sqlNamesOrgId = {
  meta: {
    type: 'problem',
    docs: { description: 'A raw query touching an org-scoped table must name org_id.' },
    schema: [{ type: 'object', properties: { tables: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      missing:
        'This query reads or writes {{tables}}, which {{verb}} an org_id column, and the statement never mentions org_id. ' +
        'Add it to every WHERE and every INSERT. If this really is a cross-organisation read -- a platform sweep or a ' +
        'migration -- say so in a disable comment with the reason, so the next reader knows it was decided rather than missed.',
    },
  },
  create(context) {
    const scoped = new Set(context.options[0]?.tables ?? ORG_SCOPED_TABLES);
    return {
      TaggedTemplateExpression(node) {
        if (node.tag.type !== 'Identifier' || node.tag.name !== 'sql') return;
        const text = templateText(node);
        if (/org_id/i.test(text)) return;
        const touched = [...tablesIn(text)].filter((t) => scoped.has(t));
        if (touched.length === 0) return;
        context.report({
          node,
          messageId: 'missing',
          data: { tables: touched.join(', '), verb: touched.length === 1 ? 'has' : 'have' },
        });
      },
    };
  },
};

export const orgScope = {
  rules: {
    'repository-is-org-bound': repositoryIsOrgBound,
    'sql-names-org-id': sqlNamesOrgId,
  },
};
