/**
 * Odoo Domain Filter Conversion
 *
 * Converts our unified filter syntax to Odoo's domain format.
 * Odoo domains: [['field', 'operator', 'value'], ...]
 */

import type { FilterCondition, FilterOperator } from '@datatrust/core';

/** Odoo domain tuple: [field, operator, value] */
export type OdooDomainTuple = [string, string, unknown];

/** Simple Odoo domain (AND logic only, no '&' / '|' operators) */
export type OdooDomain = OdooDomainTuple[];

/**
 * Map our filter operators to Odoo operators
 */
const OPERATOR_MAP: { [K in FilterOperator]: string } = {
  eq: '=',
  neq: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  contains: 'ilike',
  in: 'in',
};

/**
 * Convert a single filter condition to Odoo domain tuple
 */
function conditionToDomain(condition: FilterCondition): OdooDomainTuple {
  const odooOp = OPERATOR_MAP[condition.op];

  // For 'contains', wrap value with %
  if (condition.op === 'contains') {
    return [condition.field, odooOp, `%${condition.value}%`];
  }

  return [condition.field, odooOp, condition.value];
}

/**
 * Convert our unified filter conditions to Odoo domain
 *
 * Our filters use AND logic by default, which matches Odoo's default behavior.
 */
export function toDomain(conditions?: FilterCondition[]): OdooDomain {
  if (!conditions || conditions.length === 0) {
    return [];
  }

  return conditions.map(conditionToDomain);
}

/**
 * Convert Odoo domain back to our filter conditions
 */
export function fromDomain(domain: OdooDomain): FilterCondition[] {
  return domain.map(([field, odooOp, value]) => {
    // Find our operator from Odoo's
    let op: FilterOperator = 'eq';
    for (const [key, val] of Object.entries(OPERATOR_MAP)) {
      if (val === odooOp) {
        op = key as FilterOperator;
        break;
      }
    }

    return { field, op, value };
  });
}
