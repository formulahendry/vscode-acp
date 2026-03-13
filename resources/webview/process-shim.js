(() => {
  const currentProcess = globalThis.process && typeof globalThis.process === 'object'
    ? globalThis.process
    : {};

  const env = currentProcess.env && typeof currentProcess.env === 'object'
    ? currentProcess.env
    : {};

  globalThis.process = {
    ...currentProcess,
    env: {
      ...env,
      NODE_ENV: env.NODE_ENV || 'production',
    },
  };
})();
