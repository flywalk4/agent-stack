#!/usr/bin/env node
const [cmd = 'install', ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);

switch (cmd) {
  case 'install': {
    const { install } = await import('../src/install.js');
    await install({ yes: flag('--yes') || flag('-y') });
    break;
  }
  case 'uninstall': {
    const { uninstall } = await import('../src/install.js');
    await uninstall();
    break;
  }
  case 'doctor':
  case 'status': {
    const { doctor } = await import('../src/doctor.js');
    await doctor({ json: flag('--json') });
    break;
  }
  case 'dashboard': {
    const { serve } = await import('../src/dashboard/server.js');
    const { SERVICES } = await import('../src/topology.js');
    const { probe } = await import('../src/services.js');
    // Without --serve: open the already-running service, else run in foreground.
    if (!flag('--serve') && await probe(SERVICES.dashboard.port, SERVICES.dashboard.health)) {
      const { isWin, isMac, run } = await import('../src/platform.js');
      const u = `http://127.0.0.1:${SERVICES.dashboard.port}`;
      run(isWin ? 'cmd' : isMac ? 'open' : 'xdg-open', isWin ? ['/c', 'start', '', u] : [u]);
      console.log(u);
    } else {
      serve();
    }
    break;
  }
  default:
    console.log(`agent-stack <command>

  install [--yes]   interactive setup: asks install or uninstall (--yes = everything
                    detected, no questions); running with no command does the same
  doctor [--json]   check services, configs and end-to-end chains
  dashboard         open the shared dashboard
  uninstall         remove the services, restore configs from backups`);
}
