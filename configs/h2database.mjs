// configs/h2database.mjs — H2 Database Java parser configuration
// 사용 (Usage): node quarkify.mjs configs/h2database.mjs
// 출력 (Output): /path/to/your/workspace/quarkify/h2database_output

export default {
  name: 'h2database-java-analysis',
  srcDir: '/path/to/your/workspace/quarkify/h2database',
  outDir: '/path/to/your/workspace/quarkify/h2database_output',

  sourceFiles: [
    'h2/src/main/org/h2/Driver.java',
    'h2/src/main/org/h2/command/Parser.java',
    'h2/src/main/org/h2/jdbc/JdbcConnection.java',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('connect') || n.includes('login') || n.includes('session')) return 'connection';
    if (n.includes('parse') || n.includes('tokenize') || n.includes('lex')) return 'parser';
    if (n.includes('execute') || n.includes('run') || n.includes('query')) return 'execution';
    if (n.includes('store') || n.includes('page') || n.includes('disk') || n.includes('file')) return 'storage';
    if (n.includes('index') || n.includes('btree')) return 'indexing';
    return 'general';
  },
};
