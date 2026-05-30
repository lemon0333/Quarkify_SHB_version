export default {
  name: 'requests-library-analysis',
  srcDir: '/path/to/your/workspace/quarkify/requests',
  outDir: '/path/to/your/workspace/quarkify/requests_output',

  sourceFiles: [
    'src/requests/**/*.py',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('adapter') || n.includes('api')) return 'network_connector';
    if (n.includes('model') || n.includes('status')) return 'data_model';
    if (n.includes('session') || n.includes('cookie')) return 'session_manager';
    if (n.includes('auth')) return 'authenticator';
    if (n.includes('exception') || n.includes('error')) return 'error_handler';
    return 'general';
  },
};
