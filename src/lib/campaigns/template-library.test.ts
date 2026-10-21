import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import {
  countByGroup,
  filterTemplates,
  insertVariable,
  missingVariableIndices,
  nextVariableIndex,
  pruneBindings,
  statusGroup,
  variableLabels,
} from './template-library';

const tpl = (o: Partial<MessageTemplate>): MessageTemplate => ({
  id: o.name ?? 'x', user_id: 'u1', name: 'x', category: 'Marketing', language: 'en',
  body_text: 'Hello', created_at: '2026-10-01T00:00:00Z', ...o,
});

const list = [
  tpl({ name: 'site_visit', status: 'APPROVED', created_by: 'u2' }),
  tpl({ name: 'otp_code', status: 'PENDING', category: 'Utility' }),
  tpl({ name: 'old_offer', status: 'REJECTED', body_text: 'Diwali offer' }),
  tpl({ name: 'draft_one', status: 'DRAFT' }),
  tpl({ name: 'paused_one', status: 'PAUSED' }),
];

describe('template library filters', () => {
  it('groups statuses like the library tabs', () => {
    expect(statusGroup('IN_APPEAL')).toBe('pending');
    expect(statusGroup(undefined)).toBe('other');
    expect(countByGroup(list)).toEqual({ all: 5, approved: 1, pending: 1, rejected: 1, other: 2 });
  });

  it('combines search, status, category and creator', () => {
    expect(filterTemplates(list, { search: 'diwali' }).map((t) => t.name)).toEqual(['old_offer']);
    expect(filterTemplates(list, { group: 'other' })).toHaveLength(2);
    expect(filterTemplates(list, { category: 'Utility' }).map((t) => t.name)).toEqual(['otp_code']);
    // created_by wins over the legacy user_id
    expect(filterTemplates(list, { createdBy: 'u2' }).map((t) => t.name)).toEqual(['site_visit']);
    expect(filterTemplates(list, { createdBy: 'u1' })).toHaveLength(4);
  });
});

describe('template variables', () => {
  it('numbers new variables after the highest used, across header and body', () => {
    expect(nextVariableIndex('Hi')).toBe(1);
    expect(nextVariableIndex('Hi {{1}}, see {{2}}', '{{3}}')).toBe(4);
  });

  it('inserts at the caret', () => {
    expect(insertVariable('Hi !', 1, 3)).toEqual({ text: 'Hi {{1}}!', caret: 8 });
    expect(insertVariable('Hi', 2)).toEqual({ text: 'Hi{{2}}', caret: 7 });
  });

  it('reports gaps Meta would reject', () => {
    expect(missingVariableIndices('{{1}} {{3}}')).toEqual([2]);
    expect(missingVariableIndices('{{1}} {{2}}')).toEqual([]);
  });

  it('prunes bindings for deleted variables and labels the preview', () => {
    const bindings = {
      '1': { type: 'field' as const, value: 'name' },
      '2': { type: 'custom_field' as const, value: 'cf-1', label: 'Project' },
    };
    expect(pruneBindings(bindings, 'Hi {{1}}')).toEqual({ '1': bindings['1'] });
    const labels = variableLabels(['', 'Garden City'], bindings, (b) => (b.type === 'custom_field' ? b.label ?? '' : b.value));
    expect(labels).toEqual({ '1': 'name', '2': 'Garden City' });
  });
});
