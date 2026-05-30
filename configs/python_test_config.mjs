export default {
  name: 'python-test-analysis',
  srcDir: '/path/to/your/workspace/quarkify',
  outDir: '/path/to/your/workspace/quarkify/python_test_output',

  sourceFiles: [
    'scratch/*.py',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('get')) return 'read_operation';
    return 'general';
  },
};
