import { describeConstraint } from '../db/pg-error.js';

/**
 * The sentence behind the rule `integration_connections` keeps.
 *
 * The database decides; this is what a person reads when it refuses. Imported
 * for its side effect by the module, the way sales does it.
 */
describeConstraint(
  'integration_connections_one_door',
  'This connection already has the other credential. One company, one connection, one door — issue the agent token or the webhook secret, not both, or create a separate connection.',
);
