/**
 * D2's vocabulary, shared by the matrix and every sheet that names a cell.
 * Lives apart from the components so fast refresh keeps working.
 */
export const STATES = [
  { key: 'new', label: 'New' },
  { key: 'reactivated', label: 'Reactivated' },
  { key: 'growing', label: 'Growing' },
  { key: 'flat', label: 'Flat' },
  { key: 'declining', label: 'Declining' },
  { key: 'lost', label: 'Lost' },
];
export const BANDS = ['A', 'B', 'C'];
