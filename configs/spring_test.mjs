export default {
  name: 'spring-test-analysis',
  srcDir: '/path/to/your/workspace/quarkify',
  outDir: '/path/to/your/workspace/quarkify/spring_test_output',

  // Glob 자동 매핑을 테스트하기 위한 와일드카드 설정 (Wildcard settings for testing auto-glob mapping)
  sourceFiles: [
    'scratch/*.java',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('controller')) return 'web_endpoint';
    if (n.includes('service')) return 'business_logic';
    return 'general';
  },
};
