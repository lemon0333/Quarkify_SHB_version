export default {
  name: 'hoppscotch-ts-analysis',
  srcDir: '/path/to/your/workspace/quarkify/hoppscotch',
  outDir: '/path/to/your/workspace/quarkify/hoppscotch_output',

  // 핵심 TypeScript 공통 소스 디렉터리 일괄 매핑
  sourceFiles: [
    'packages/hoppscotch-common/src/**/*.ts',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('store') || n.includes('session')) return 'state_store';
    if (n.includes('helper') || n.includes('util')) return 'utility';
    if (n.includes('component') || n.includes('view')) return 'ui_component';
    return 'general';
  },
};
