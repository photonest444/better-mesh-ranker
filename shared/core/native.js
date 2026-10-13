/*!
 * Mesh Ranker — мост к нативному ядру на Rust (`mesh-rank serve`).
 *
 * Зачем: разбор ответов МЭШ, сборка таблицы рейтинга, сводки, прогноз и CSV —
 * «горячие» вычисления, которые на Rust идут на порядок быстрее JS. При этом
 * интерфейс и ядро остаются прежними: мост вызывается как необязательный
 * ускоритель, и при любой проблеме (бинарника нет, он упал, таймаут) ядро
 * молча возвращается к чистой JS-реализации.
 *
 * В браузере/WebView модуль не нужен: там Node нет, экспортируется заглушка.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('path'), require('fs'), require('child_process'), require('os'));
  } else {
    // Браузер, Android WebView, Electron renderer: моста нет — есть заглушка,
    // чтобы интерфейс мог одинаково спросить «доступно ли нативное ядро».
    root.MeshNativeBridge = {
      isNode: false,
      available: function () { return false; },
      descriptor: function () {
        return { available: false, engine: 'js', reason: 'Нативное ядро доступно только в Node/Electron-процессе' };
      },
      createAccelerator: function () { return null; },
      reset: function () {}
    };
  }
})(typeof self !== 'undefined' ? self : this, function (path, fs, childProcess, os) {
  'use strict';

  var DEFAULT_TIMEOUT = 5000;
  var FAIL_COOLDOWN_MS = 30000;
  var EXE = process.platform === 'win32' ? 'mesh-rank.exe' : 'mesh-rank';

  var state = {
    binary: null,
    reason: null,
    failedAt: 0,
    child: null,
    starting: null,
    hello: null,
    stderr: '',
    pending: {},
    counter: 0,
    calls: 0,
    errors: 0,
    lastError: null,
    disposed: false
  };

  function isExecutable(file) {
    try {
      var info = fs.statSync(file);
      return info.isFile();
    } catch (error) {
      return false;
    }
  }

  /** Ищет бинарник: явный путь → переменная окружения → упакованное приложение → репозиторий → PATH. */
  function locateBinary(options) {
    var opts = options || {};
    var candidates = [];
    var here = __dirname || '.';
    var repoRoot = path.resolve(here, '..', '..');

    if (opts.binary) candidates.push(opts.binary);
    if (process.env.MESH_RANKER_RUST_BIN) candidates.push(process.env.MESH_RANKER_RUST_BIN);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', EXE));
    candidates.push(path.join(repoRoot, 'desktop', 'bin', EXE));
    candidates.push(path.join(repoRoot, 'rust', 'target', 'release', EXE));
    candidates.push(path.join(repoRoot, 'rust', 'target', 'debug', EXE));
    candidates.push(path.join(here, EXE));
    if (process.env.PATH) {
      process.env.PATH.split(path.delimiter).forEach(function (dir) {
        if (dir) candidates.push(path.join(dir, EXE));
      });
    }

    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index];
      if (candidate && isExecutable(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Аргументы запуска. `opts.args` вставляются перед `serve` — это нужно тестам
   * (запуск мок-бинарника через `node tools/mock-mesh-rank.js`) и, при желании,
   * обёрткам вроде `wine`/`qemu`.
   */
  function extraArgs(options) {
    var opts = options || {};
    var args = (opts.args || []).slice();
    args.push('serve');
    if (opts.dataDir) args.push('--data-dir', opts.dataDir);
    if (opts.token) args.push('--token', opts.token);
    if (opts.profileId) args.push('--profile-id', opts.profileId);
    if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
    if (opts.demo) args.push('--demo');
    if (opts.timeoutMs) args.push('--timeout', String(opts.timeoutMs));
    if (opts.noColor !== false) args.push('--no-color');
    return args;
  }

  function handleLine(line, options) {
    var trimmed = line.trim();
    if (!trimmed) return;
    var message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      if (options.onLog) options.onLog('native: некорректный ответ ' + trimmed.slice(0, 200));
      return;
    }
    var pending = state.pending[message.id];
    if (!pending) return;
    delete state.pending[message.id];
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      var error = new Error((message.error && message.error.message) || 'Ошибка нативного ядра');
      error.code = (message.error && message.error.code) || 'native-error';
      error.raw = message.error && message.error.raw;
      pending.reject(error);
    }
  }

  function shutdown(reason) {
    if (state.child) {
      try { state.child.kill(); } catch (error) { /* уже умер */ }
    }
    state.child = null;
    state.hello = null;
    state.starting = null;
    state.reason = reason || state.reason;
    Object.keys(state.pending).forEach(function (id) {
      var pending = state.pending[id];
      delete state.pending[id];
      var error = new Error('Нативное ядро недоступно: ' + (state.reason || 'неизвестная причина'));
      error.code = 'native-unavailable';
      pending.reject(error);
    });
  }

  /** Запускает `mesh-rank serve` и делает рукопожатие. */
  function start(options) {
    var opts = options || {};
    if (state.child) return Promise.resolve(state.hello);
    if (state.starting) return state.starting;
    if (state.disposed) return Promise.reject(new Error('Мост уже остановлен'));

    // Недавняя неудача: не запускаем процесс повторно на каждый вызов.
    if (!opts.force && state.reason && Date.now() - state.failedAt < FAIL_COOLDOWN_MS) {
      return Promise.reject(Object.assign(new Error(state.reason), { code: 'native-unavailable' }));
    }
    var binary = locateBinary(opts);
    if (!binary) {
      state.reason = 'Бинарник mesh-rank не найден (соберите: cargo build --release в каталоге rust)';
      state.failedAt = Date.now();
      return Promise.reject(Object.assign(new Error(state.reason), { code: 'native-unavailable' }));
    }
    state.binary = binary;
    var args = extraArgs(opts);

    state.starting = new Promise(function (resolve, reject) {
      var child;
      try {
        child = childProcess.spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        state.starting = null;
        state.reason = 'Не удалось запустить ' + binary + ': ' + error.message;
        return reject(Object.assign(new Error(state.reason), { code: 'native-unavailable' }));
      }
      state.child = child;
      state.stderr = '';

      var buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function (chunk) {
        buffer += chunk;
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function (line) { handleLine(line, opts); });
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function (chunk) {
        state.stderr = (state.stderr + chunk).slice(-4000);
        if (opts.onLog) opts.onLog('native: ' + chunk.trim());
      });
      child.on('error', function (error) {
        state.reason = 'Ошибка нативного ядра: ' + error.message;
        state.failedAt = Date.now();
        shutdown(state.reason);
        reject(Object.assign(new Error(state.reason), { code: 'native-unavailable' }));
      });
      child.on('exit', function (code, signal) {
        if (state.child === child) {
          state.reason = 'Нативное ядро завершилось (код ' + code + (signal ? ', сигнал ' + signal : '') + ')';
          shutdown(state.reason);
        }
      });

      send({ method: 'hello', params: {} }, opts.timeoutMs || DEFAULT_TIMEOUT)
        .then(function (hello) {
          state.hello = hello;
          state.starting = null;
          if (opts.onLog) opts.onLog('native: ядро ' + hello.version + ' готово (' + binary + ')');
          resolve(hello);
        })
        .catch(function (error) {
          state.starting = null;
          state.reason = state.reason || ('Нативное ядро не ответило: ' + error.message);
          state.failedAt = Date.now();
          shutdown(state.reason);
          reject(Object.assign(new Error(state.reason), { code: 'native-unavailable' }));
        });
    });
    return state.starting;
  }

  /** Отправляет один запрос мосту (без старта — используется только внутри). */
  function send(request, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!state.child || !state.child.stdin.writable) {
        return reject(Object.assign(new Error('Нативное ядро не запущено'), { code: 'native-unavailable' }));
      }
      state.counter += 1;
      var id = 'js' + state.counter;
      var payload = JSON.stringify({ id: id, method: request.method, params: request.params || {} });
      var timer = setTimeout(function () {
        delete state.pending[id];
        state.errors += 1;
        reject(Object.assign(new Error('Нативное ядро не ответило за ' + timeoutMs + ' мс'), { code: 'native-timeout' }));
      }, timeoutMs);
      state.pending[id] = {
        resolve: function (value) { clearTimeout(timer); resolve(value); },
        reject: function (error) { clearTimeout(timer); reject(error); }
      };
      try {
        state.child.stdin.write(payload + '\n');
      } catch (error) {
        clearTimeout(timer);
        delete state.pending[id];
        reject(Object.assign(new Error('Не удалось отправить запрос нативному ядру: ' + error.message), { code: 'native-unavailable' }));
      }
    });
  }

  /**
   * Вызов метода нативного ядра.
   * @param {string} method например 'rank.build'
   * @param {object} params
   * @param {{timeoutMs?:number, log?:Function, binary?:string, dataDir?:string}} options
   */
  function call(method, params, options) {
    var opts = options || {};
    state.calls += 1;
    return start(opts)
      .then(function () {
        return send({ method: method, params: params }, opts.timeoutMs || DEFAULT_TIMEOUT);
      })
      .catch(function (error) {
        state.errors += 1;
        state.lastError = error;
        throw error;
      });
  }

  /** Доступно ли нативное ядро прямо сейчас (не запускает процесс). */
  function available() {
    if (state.child) return true;
    return !!locateBinary({});
  }

  /** Описание состояния — показывается в интерфейсе и в /api/native. */
  function descriptor() {
    var hello = state.hello;
    return {
      available: !!state.child,
      engine: hello ? 'rust' : 'js',
      binary: state.binary || locateBinary({}),
      version: hello ? hello.version : null,
      transport: hello ? hello.transport : null,
      methods: hello ? (hello.methods || []).length : 0,
      calls: state.calls,
      errors: state.errors,
      reason: state.child ? null : state.reason,
      lastError: state.lastError ? state.lastError.message : null,
      protocol: hello ? hello.protocol : null
    };
  }

  /**
   * Ускоритель для JS-ядра: те же вычисления, но на Rust.
   * Все методы возвращают Promise и могут падать — MeshCore это переживёт.
   */
  function createAccelerator(options) {
    var opts = options || {};
    if (!locateBinary(opts) && !state.child) return null;

    function invoke(method, params, timeoutMs) {
      return call(method, params, Object.assign({}, opts, { timeoutMs: timeoutMs || opts.timeoutMs }));
    }

    return {
      name: 'rust',
      describe: descriptor,
      ready: function () { return start(opts).then(descriptor).catch(function () { return descriptor(); }); },
      rankBoard: function (payload) {
        return invoke('rank.build', payload, 2500);
      },
      summarizeMarks: function (marks) {
        return invoke('marks.summarize', { marks: marks }, 2500);
      },
      normalizeSchedule: function (payload) {
        return invoke('schedule.normalize', { payload: payload }, 2500);
      },
      deadlines: function (homeworks, reference) {
        return invoke('homeworks.deadlines', { homeworks: homeworks, reference: reference }, 2500);
      },
      forecast: function (marks, target, remaining) {
        return invoke('insights.forecast', { marks: marks, target: target, remaining: remaining }, 2500);
      },
      impact: function (marks, limit) {
        return invoke('insights.impact', { marks: marks, limit: limit }, 2500);
      },
      history: function (snapshots, subjectId) {
        return invoke('insights.history', { snapshots: snapshots, subjectId: subjectId }, 2500);
      },
      csvRank: function (rows, title) {
        return invoke('csv.rank', { rows: rows, title: title }, 4000);
      },
      bench: function (params) {
        return invoke('bench', params || {}, 20000);
      },
      raw: invoke,
      dispose: function () { reset(); }
    };
  }

  /** Останавливает процесс (например, при выходе приложения). */
  function reset() {
    state.disposed = false;
    shutdown('Мост остановлен');
    state.reason = null;
    state.failedAt = 0;
    state.binary = null;
    state.hello = null;
    state.calls = 0;
    state.errors = 0;
    state.lastError = null;
  }

  return {
    isNode: true,
    EXE: EXE,
    locateBinary: locateBinary,
    available: available,
    availableSync: available,
    start: start,
    call: call,
    descriptor: descriptor,
    createAccelerator: createAccelerator,
    reset: reset,
    defaultDataDir: function () {
      return path.join(os.tmpdir ? os.tmpdir() : '.', 'mesh-ranker');
    }
  };
});
