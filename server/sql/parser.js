// Smartbase SQL Parser - Controlled Subset
// Converts SQL text into Command Objects

export class SQLParser {
  constructor() {
    this.supportedCommands = [
      'CREATE DATABASE', 'SHOW DATABASES', 'DROP DATABASE',
      'CREATE TABLE', 'SHOW TABLES', 'DROP TABLE',
      'INSERT', 'SELECT', 'UPDATE', 'DELETE'
    ];
  }

  parse(sql, context = {}) {
    if (!sql || typeof sql !== 'string') throw { code: 'INVALID_SQL', message: 'SQL query is empty' };
    
    const trimmed = sql.trim();
    if (!trimmed) throw { code: 'INVALID_SQL', message: 'SQL query is empty' };

    // Remove trailing semicolon
    const clean = trimmed.replace(/;\s*$/, '').trim();
    const upper = clean.toUpperCase();

    try {
      if (upper.startsWith('CREATE DATABASE')) return this.parseCreateDatabase(clean);
      if (upper === 'SHOW DATABASES') return { operation: 'SHOW_DATABASES' };
      if (upper.startsWith('DROP DATABASE')) return this.parseDropDatabase(clean);
      
      if (upper.startsWith('CREATE TABLE')) return this.parseCreateTable(clean, context);
      if (upper === 'SHOW TABLES') return { operation: 'SHOW_TABLES', database_id: context.database_id };
      if (upper.startsWith('DROP TABLE')) return this.parseDropTable(clean);

      if (upper.startsWith('INSERT INTO')) return this.parseInsert(clean);
      if (upper.startsWith('SELECT')) return this.parseSelect(clean);
      if (upper.startsWith('UPDATE')) return this.parseUpdate(clean);
      if (upper.startsWith('DELETE FROM')) return this.parseDelete(clean);

      throw { code: 'UNSUPPORTED_SQL', message: `Unsupported SQL: ${clean.substring(0, 50)}... Supported: ${this.supportedCommands.join(', ')}` };
    } catch (e) {
      if (e.code) throw e;
      throw { code: 'INVALID_SQL', message: e.message || 'Failed to parse SQL' };
    }
  }

  parseCreateDatabase(sql) {
    // CREATE DATABASE shop
    const match = sql.match(/CREATE\s+DATABASE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid CREATE DATABASE syntax. Use: CREATE DATABASE name' };
    return { operation: 'CREATE_DATABASE', name: match[1].toLowerCase(), description: '' };
  }

  parseDropDatabase(sql) {
    const match = sql.match(/DROP\s+DATABASE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid DROP DATABASE syntax. Use: DROP DATABASE name' };
    return { operation: 'DROP_DATABASE', name: match[1].toLowerCase() };
  }

  parseCreateTable(sql, context) {
    // CREATE TABLE users (id INTEGER, name TEXT, ...)
    const match = sql.match(/CREATE\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.+)\)/is);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid CREATE TABLE syntax. Use: CREATE TABLE name (col TYPE, ...)' };
    
    const tableName = match[1].toLowerCase();
    const colsStr = match[2];
    
    const columns = [];
    const colDefs = this.splitColumns(colsStr);
    
    for (const def of colDefs) {
      const colMatch = def.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(INTEGER|FLOAT|TEXT|BOOLEAN|DATE|DATETIME|JSON)(?:\s+(NOT\s+NULL|NULL))?/i);
      if (!colMatch) throw { code: 'INVALID_SQL', message: `Invalid column definition: ${def}` };
      
      columns.push({
        name: colMatch[1].toLowerCase(),
        type: colMatch[2].toUpperCase(),
        nullable: !colMatch[3] || colMatch[3].toUpperCase() !== 'NOT NULL',
        primary_key: false
      });
    }

    if (columns.length === 0) throw { code: 'INVALID_SQL', message: 'Table must have at least one column' };

    return {
      operation: 'CREATE_TABLE',
      database_id: context.database_id,
      table: { name: tableName, columns }
    };
  }

  splitColumns(str) {
    // Split by comma but respect parentheses
    const result = [];
    let current = '';
    let depth = 0;
    for (let c of str) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    if (current.trim()) result.push(current);
    return result;
  }

  parseDropTable(sql) {
    const match = sql.match(/DROP\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid DROP TABLE syntax' };
    return { operation: 'DROP_TABLE', name: match[1].toLowerCase() };
  }

  parseInsert(sql) {
    // INSERT INTO users (id, name) VALUES (1, 'John')
    const match = sql.match(/INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]+)\))?\s+VALUES\s*(.+)/is);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid INSERT syntax. Use: INSERT INTO table (cols) VALUES (vals)' };
    
    const table = match[1].toLowerCase();
    const cols = match[2] ? match[2].split(',').map(c => c.trim().toLowerCase()).filter(Boolean) : null;
    const valuesStr = match[3].trim();

    // Parse VALUES (...) , (...) 
    const values = [];
    const valueGroups = valuesStr.match(/\([^)]+\)/g);
    if (!valueGroups) throw { code: 'INVALID_SQL', message: 'Invalid VALUES clause' };

    for (const group of valueGroups) {
      const inner = group.slice(1, -1);
      const vals = this.parseValueList(inner);
      values.push(vals);
    }

    return { operation: 'INSERT', table, columns: cols, values };
  }

  parseValueList(str) {
    const vals = [];
    let current = '';
    let inQuote = false;
    let quoteChar = null;
    
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if ((c === "'" || c === '"') && !inQuote) { inQuote = true; quoteChar = c; current += c; }
      else if (c === quoteChar && inQuote) { inQuote = false; quoteChar = null; current += c; }
      else if (c === ',' && !inQuote) { vals.push(current.trim()); current = ''; }
      else current += c;
    }
    if (current.trim()) vals.push(current.trim());
    
    return vals.map(v => this.parseValue(v));
  }

  parseValue(v) {
    const trimmed = v.trim();
    if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) {
      return trimmed.slice(1, -1);
    }
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    if (/^null$/i.test(trimmed)) return null;
    if (!isNaN(trimmed) && trimmed !== '') return Number(trimmed);
    return trimmed;
  }

  parseSelect(sql) {
    // SELECT * FROM users WHERE id = 1 LIMIT 10
    const match = sql.match(/SELECT\s+(.+?)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?\s*$/is);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid SELECT syntax. Use: SELECT * FROM table [WHERE ...] [ORDER BY ...] [LIMIT ...]' };
    
    const columns = match[1].trim();
    const table = match[2].toLowerCase();
    const where = match[3] ? match[3].trim() : null;
    const orderBy = match[4] ? match[4].toLowerCase() : null;
    const orderDir = match[5] ? match[5].toUpperCase() : 'ASC';
    const limit = match[6] ? parseInt(match[6]) : null;

    return {
      operation: 'SELECT',
      table,
      columns: columns === '*' ? '*' : columns.split(',').map(c => c.trim().toLowerCase()),
      where,
      orderBy,
      orderDir,
      limit
    };
  }

  parseUpdate(sql) {
    // UPDATE users SET age = 26 WHERE id = 1
    const match = sql.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?\s*$/is);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid UPDATE syntax. Use: UPDATE table SET col = val WHERE ...' };
    
    const table = match[1].toLowerCase();
    const setStr = match[2];
    const where = match[3] ? match[3].trim() : null;

    const sets = {};
    const assignments = setStr.split(',').map(s => s.trim());
    for (const assign of assignments) {
      const m = assign.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (!m) throw { code: 'INVALID_SQL', message: `Invalid SET assignment: ${assign}` };
      sets[m[1].toLowerCase()] = this.parseValue(m[2]);
    }

    return { operation: 'UPDATE', table, sets, where };
  }

  parseDelete(sql) {
    const match = sql.match(/DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+WHERE\s+(.+))?\s*$/is);
    if (!match) throw { code: 'INVALID_SQL', message: 'Invalid DELETE syntax. Use: DELETE FROM table [WHERE ...]' };
    return { operation: 'DELETE', table: match[1].toLowerCase(), where: match[2] ? match[2].trim() : null };
  }

  // Simple WHERE evaluator for V1 - supports col = value, col != value, col > value etc
  evaluateWhere(record, whereClause) {
    if (!whereClause) return true;
    
    // Support simple AND conditions
    const conditions = whereClause.split(/\s+AND\s+/i);
    
    for (const cond of conditions) {
      const m = cond.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|!=|>|<|>=|<=)\s*(.+)$/);
      if (!m) continue; // skip invalid for now
      
      const col = m[1].toLowerCase();
      const op = m[2];
      const val = this.parseValue(m[3].trim());
      
      const recVal = record[col];
      
      let result = false;
      switch (op) {
        case '=': result = recVal == val; break;
        case '!=': result = recVal != val; break;
        case '>': result = recVal > val; break;
        case '<': result = recVal < val; break;
        case '>=': result = recVal >= val; break;
        case '<=': result = recVal <= val; break;
      }
      
      if (!result) return false;
    }
    
    return true;
  }
}

export const sqlParser = new SQLParser();
