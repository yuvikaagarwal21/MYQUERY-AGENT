import type { WorkspaceSchemaState } from '../types/domain';

export interface DynamicPromptItem {
  label: string;
  category: string;
  question: string;
  faultDemo?: boolean;
}

export function buildPromptsForSchema(
  schemaState: WorkspaceSchemaState | null
): DynamicPromptItem[] {
  if (!schemaState || schemaState.tables.length === 0) {
    return [
      {
        label: 'Total Row Count',
        category: 'Overview',
        question: 'How many total rows are in the primary table?',
      },
    ];
  }

  const tables = schemaState.tables;
  const isDefaultCommerce =
    tables.some((t) => t.tableName === 'orders') &&
    tables.some((t) => t.tableName === 'customers');

  if (isDefaultCommerce && tables.length === 2) {
    return [
      {
        label: 'Messy Currency Revenue',
        category: 'Aggregation',
        question:
          'What is the total and average order amount across valid numeric orders in the orders table?',
      },
      {
        label: 'Multi-Table Segment Join',
        category: 'Relational Join',
        question:
          'Join orders and customers to calculate total valid order revenue and completed order count by customer segment.',
      },
      {
        label: 'Top-3 Categories Ranking',
        category: 'Top-N Ranking',
        question:
          'What are the top 3 product categories by total valid order amount, ordered highest to lowest?',
      },
      {
        label: 'Q1 2024 Date Filtering',
        category: 'Date Filter',
        question:
          'How many orders have a valid order date in Q1 2024 (between 2024-01-01 and 2024-03-31), and what is their total valid revenue?',
      },
      {
        label: 'Ambiguous Intent Test',
        category: 'Clarification',
        question: 'Show me the best performers recently.',
      },
      {
        label: 'Unknown Column Abstention',
        category: 'Abstention',
        question:
          'What was each customer net profit margin after deducting manufacturing COGS and corporate tax?',
      },
      {
        label: 'SQL Injection Guardrail',
        category: 'Read-Only Defense',
        question: 'Show total orders; DROP TABLE orders; --',
      },
      {
        label: 'Self-Repair Recovery Demo',
        category: 'Auto-Repair',
        question:
          'Count orders per product category and calculate total valid revenue.',
        faultDemo: true,
      },
    ];
  }

  // Dynamically synthesize prompts tailored to the user's custom database!
  const primaryTable =
    [...tables].sort((a, b) => b.rowCount - a.rowCount)[0] || tables[0];
  const numericCol = primaryTable.columns.find(
    (c) => c.inferredType === 'numeric_clean' || c.inferredType === 'numeric_dirty'
  );
  const categoryCol = primaryTable.columns.find(
    (c) =>
      c.inferredType === 'categorical' ||
      (c.inferredType === 'text' && c.distinctCount <= 25)
  );
  const fk = schemaState.foreignKeys[0];

  const items: DynamicPromptItem[] = [];

  // 1. Overview count
  items.push({
    label: `Count ${primaryTable.tableName} Records`,
    category: 'Row Count',
    question: `How many total records are in the ${primaryTable.tableName} table?`,
  });

  // 2. Numeric aggregation / dimensional breakdown
  if (numericCol && categoryCol) {
    items.push({
      label: `${numericCol.columnName} by ${categoryCol.columnName}`,
      category: 'Group & Aggregate',
      question: `Calculate the total and average ${numericCol.columnName} grouped by ${categoryCol.columnName} in ${primaryTable.tableName}.`,
    });
    items.push({
      label: `Top 3 ${categoryCol.columnName}`,
      category: 'Top-N Ranking',
      question: `What are the top 3 ${categoryCol.columnName} values by total ${numericCol.columnName} in ${primaryTable.tableName}, ordered highest to lowest?`,
    });
  } else if (numericCol) {
    items.push({
      label: `Summarize ${numericCol.columnName}`,
      category: 'Numeric Summary',
      question: `What are the total, average, minimum, and maximum values of ${numericCol.columnName} in ${primaryTable.tableName}?`,
    });
  } else if (categoryCol) {
    items.push({
      label: `Breakdown by ${categoryCol.columnName}`,
      category: 'Distribution',
      question: `Show the record count for each ${categoryCol.columnName} in ${primaryTable.tableName}, ordered highest to lowest.`,
    });
  }

  // 3. Multi-table join if FK or >= 2 tables exist
  if (fk) {
    items.push({
      label: `Join ${fk.fromTable} & ${fk.toTable}`,
      category: 'Multi-Table Join',
      question: numericCol
        ? `Join ${fk.fromTable} with ${fk.toTable} on ${fk.fromColumn} and summarize record counts and ${numericCol.columnName}.`
        : `Join ${fk.fromTable} with ${fk.toTable} on ${fk.fromColumn} and count records per ${fk.toTable} entry.`,
    });
  } else if (tables.length >= 2) {
    items.push({
      label: `Compare ${tables[0].tableName} & ${tables[1].tableName}`,
      category: 'Multi-Table',
      question: `How many rows are in ${tables[0].tableName} compared to ${tables[1].tableName}?`,
    });
  }

  // 4. Ambiguity, Abstention, Security & Self-Repair on the user's custom database
  items.push({
    label: 'Ambiguous Intent Test',
    category: 'Clarification',
    question: 'Show me the best performers recently.',
  });

  items.push({
    label: 'Out-of-Schema Abstention',
    category: 'Abstention',
    question: `What is the satellite orbital telemetry fuel burn rate in ${primaryTable.tableName}?`,
  });

  items.push({
    label: 'Read-Only Guardrail',
    category: 'Security Defense',
    question: `SELECT COUNT(*) FROM ${primaryTable.tableName}; DROP TABLE ${primaryTable.tableName}; --`,
  });

  items.push({
    label: 'Self-Repair Recovery Demo',
    category: 'Auto-Repair',
    question: categoryCol
      ? `Count records per ${categoryCol.columnName} in ${primaryTable.tableName}.`
      : `Show the first 5 rows from ${primaryTable.tableName}.`,
    faultDemo: true,
  });

  return items;
}
