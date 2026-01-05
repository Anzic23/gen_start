// Управление генератором и вводами (wb-rules)
// v5.4 - Улучшения моточасов и Telegram
// - Исправлено: моточасы считаются при перезапуске скрипта
// - Исправлено: логирование только при смене часа (не каждую минуту)
// - Telegram интеграция для всех событий
// - Детальная статистика: дни, часы, минуты
// - Частое обновление моточасов (каждые 10 сек)

// =============== КОНФИГУРАЦИЯ ==================================
var CFG = {
  GEN_VDEV: "gen_virtual",

  // Telegram оповещения
  TELEGRAM_TOKEN: "xxxx",
  TELEGRAM_CHAT_ID: "xxxx",
  TELEGRAM_ENABLED: true,

  GEN_RELAY_DEVICE: "wb-mr6c_76",
  CONTACTOR_DEVICE: "wb-mr3_33",
  GPIO_DEVICE: "wb-gpio",
  VIN_DEVICE: "power_status",
  VIN_CONTROL: "Vin",

  OIL_INPUT: "EXT1_IN3",
  GEN_VOLTAGE_INPUT: "EXT1_IN6",

  STARTER_RELAY: "K1",
  STOP_RELAY: "K2",
  CHOKE_RELAY: "K3",

  GRID_K1: "K1",
  GEN_K2: "K2",

  GRID_RELAY_INVERTED: true,
  GEN_RELAY_INVERTED: true,

  GRID_METER_DEVICE: "wb-map3et_90",
  GRID_V_L1: "Urms L1",
  GRID_V_L2: "Urms L2",
  GRID_V_L3: "Urms L3",

  GRID_V_MIN: 175,
  GRID_V_MAX: 255,

  START_ATTEMPTS_MAX: 4,
  START_SPIN_SEC: 7,
  START_REST_SEC: 5,
  START_RELEASE_DELAY_SEC: 0.5,
  START_MAX_SEC: 10,

  CHOKE_CLOSE_AFTER_RELEASE_SEC: 5,
  WARMUP_SEC: 30,
  WARMUP_GRID_STABLE_SEC: 10,

  RETURN_WAIT_SEC: 20,
  k2_OFF_AFTER_RETURN_SEC: 5,
  STOP_PULSE_SEC: 10,

  GRID_CHECK_INTERVAL_SEC: 30,
  GRID_FAIL_DEBOUNCE_SEC: 3,

  VIN_MIN: 11.0,

  MANUAL_START_COOLDOWN_SEC: 2,

  CHOKE_CHECK_INTERVAL_SEC: 10,
  CHOKE_MAX_OPEN_TIME_SEC: 10,

  ENGINE_HOURS_UPDATE_INTERVAL_SEC: 10
};

// =============== СОСТОЯНИЕ =====================================
var st = {
  grid_ok: false,
  generator_voltage: false,
  autostart_in_progress: false,
  return_in_progress: false,
  warmup_in_progress: false,
  manual_start_in_progress: false,
  attempts: 0,
  starter_active: false,
  starter_release_window: false,
  grid_fail_timestamp: null,
  grid_restored_during_warmup: null,
  last_manual_start: 0,
  choke_opened_at: null,
  choke_should_be_closed: false,
  canceling_autostart: false,

  stats: {
    total_starts: 0,
    successful_starts: 0,
    failed_starts: 0,
    engine_total_minutes: 0,
    last_start_time: null,
    engine_start_time: null
  },

  timers: {
    starter_spin: null,
    starter_watchdog: null,
    starter_release: null,
    choke_close: null,
    choke_close_manual: null,
    warmup: null,
    warmup_grid_check: null,
    return_wait: null,
    stop_pulse: null,
    k2_off_delay: null,
    grid_check_interval: null,
    start_retry: null,
    grid_fail_debounce: null,
    manual_cooldown: null,
    engine_hours_counter: null,
    choke_monitor: null
  }
};

// =============== ВИРТУАЛЬНОЕ УСТРОЙСТВО ========================
defineVirtualDevice(CFG.GEN_VDEV, {
  title: { ru: "Генератор", en: "Generator" },
  cells: {
    mode: { type: "text", value: "AUTO", enum: { "AUTO": {}, "MANUAL": {} } },
    status: { type: "text", value: "Инициализация" },
    mode_auto: { type: "switch", value: true },
    grid_ok: { type: "switch", readonly: true, value: false },
    house_on_gen: { type: "switch", readonly: true, value: false },
    oil_low: { type: "switch", readonly: true, value: false },
    vin_12v_ok: { type: "switch", readonly: true, value: false },
    voltage_l1: { type: "value", readonly: true, value: 0, precision: 1 },
    voltage_l2: { type: "value", readonly: true, value: 0, precision: 1 },
    voltage_l3: { type: "value", readonly: true, value: 0, precision: 1 },
    manual_k1_grid: { type: "switch", value: false },
    manual_k2_gen: { type: "switch", value: false },
    manual_start: { type: "pushbutton" },
    emergency_stop: { type: "switch", value: false },
    
    telegram_enabled: { type: "switch", value: true },

    total_starts: { type: "value", readonly: true, value: 0 },
    successful_starts: { type: "value", readonly: true, value: 0 },
    failed_starts: { type: "value", readonly: true, value: 0 },
    
    engine_days: { type: "value", readonly: true, value: 0, units: "д" },
    engine_hours: { type: "value", readonly: true, value: 0, units: "ч" },
    engine_minutes: { type: "value", readonly: true, value: 0, units: "м" },
    engine_total_hours: { type: "value", readonly: true, value: 0, units: "h", precision: 2 }
  }
});

// =============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =======================
function gLog(msg) {
  var fullMsg = "Генератор: " + msg;
  log(fullMsg);
  
  if (CFG.TELEGRAM_ENABLED && dev[CFG.GEN_VDEV + "/telegram_enabled"]) {
    try {
      Notify.sendTelegramMessage(CFG.TELEGRAM_TOKEN, CFG.TELEGRAM_CHAT_ID, "🔌 " + fullMsg);
    } catch (e) {
      log("⚠️ Ошибка отправки в Telegram: " + e);
    }
  }
}

function clearTimer(name) {
  if (st.timers[name]) {
    clearTimeout(st.timers[name]);
    st.timers[name] = null;
  }
}

function clearAllTimers() {
  clearTimer("starter_spin");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  clearTimer("choke_close");
  clearTimer("choke_close_manual");
  clearTimer("warmup");
  clearTimer("warmup_grid_check");
  clearTimer("return_wait");
  clearTimer("stop_pulse");
  clearTimer("k2_off_delay");
  clearTimer("grid_check_interval");
  clearTimer("start_retry");
  clearTimer("grid_fail_debounce");
  clearTimer("manual_cooldown");

  if (st.timers.choke_monitor) {
    clearInterval(st.timers.choke_monitor);
    st.timers.choke_monitor = null;
  }
}

function readContactor(path, inverted) {
  var v = dev[path];
  if (typeof v === "undefined") {
    return false;
  }
  var relayOn = !!v;
  return inverted ? !relayOn : relayOn;
}

function writeContactor(path, on, inverted) {
  var relayOn = inverted ? !on : on;
  if (dev[path] !== relayOn) {
    dev[path] = relayOn;
    return true;
  }
  return false;
}

function setK1(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1;
  var changed = writeContactor(path, !!on, CFG.GRID_RELAY_INVERTED);
  if (changed) {
    gLog("К1 (посёлок): " + (on ? "ON" : "OFF") + (reason ? " (" + reason + ")" : ""));
  }
}

function setk2(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K2;
  var changed = writeContactor(path, !!on, CFG.GEN_RELAY_INVERTED);
  if (changed) {
    gLog("К2 (генератор): " + (on ? "ON" : "OFF") + (reason ? " (" + reason + ")" : ""));
  }
}

function setChoke(open, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.CHOKE_RELAY;
  if (dev[path] !== open) {
    dev[path] = open;
    gLog("K3 (заслонка): " + (open ? "OPEN" : "CLOSED") + (reason ? " (" + reason + ")" : ""));

    if (open) {
      st.choke_opened_at = Date.now();
      st.choke_should_be_closed = false;
    } else {
      st.choke_opened_at = null;
      st.choke_should_be_closed = false;
    }
  }
}

function setStopRelay(on, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY;
  if (dev[path] !== on) {
    dev[path] = on;
    gLog("K2 (глушение): " + (on ? "ON" : "OFF") + (reason ? " (" + reason + ")" : ""));
  }
  if (on) {
    stopStarter("реле глушения активно");
  }
}

function stopStarter(reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY;
  if (st.starter_active || dev[path]) {
    dev[path] = false;
    st.starter_active = false;
    st.starter_release_window = false;
    clearTimer("starter_spin");
    clearTimer("starter_watchdog");
    clearTimer("starter_release");
    gLog("K1 (стартер): OFF" + (reason ? " (" + reason + ")" : ""));

    if (st.manual_start_in_progress) {
      st.manual_start_in_progress = false;
    }
  }
}

function startStarter(allowRetry, isManual) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY;

  if (st.starter_active) {
    gLog("⚠️ Стартер уже активен, включение игнорируется");
    return false;
  }
  if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    gLog("⚠️ Блокировка: emergency_stop");
    return false;
  }
  if (dev[CFG.GEN_VDEV + "/oil_low"]) {
    gLog("⚠️ Блокировка: низкий уровень масла");
    return false;
  }
  if (dev[CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY]) {
    gLog("⚠️ Блокировка: реле глушения активно");
    return false;
  }
  if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT] && !st.starter_release_window) {
    gLog("⚠️ Блокировка: генератор уже работает");
    return false;
  }

  if (isManual) {
    var now = Date.now();
    var elapsed = (now - st.last_manual_start) / 1000;
    if (elapsed < CFG.MANUAL_START_COOLDOWN_SEC) {
      gLog("⚠️ Cooldown: подождите " + (CFG.MANUAL_START_COOLDOWN_SEC - Math.floor(elapsed)) + " сек");
      return false;
    }
    st.last_manual_start = now;
    st.manual_start_in_progress = true;
  }

  st.starter_active = true;
  st.starter_release_window = false;
  dev[path] = true;
  gLog("K1 (стартер): ON");

  st.stats.total_starts++;
  st.stats.last_start_time = new Date().toISOString();
  updateStats();

  clearTimer("starter_watchdog");
  st.timers.starter_watchdog = setTimeout(function () {
    if (st.starter_active) {
      stopStarter("watchdog 10 сек");
      if (allowRetry && st.autostart_in_progress) {
        handleStartFailure();
      } else if (isManual) {
        st.stats.failed_starts++;
        updateStats();
      }
    }
  }, CFG.START_MAX_SEC * 1000);

  clearTimer("starter_spin");
  st.timers.starter_spin = setTimeout(function () {
    if (!st.starter_active) {
      return;
    }
    if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT]) {
      return;
    }
    stopStarter("таймаут " + CFG.START_SPIN_SEC + " сек");
    if (allowRetry && st.autostart_in_progress) {
      handleStartFailure();
    } else if (isManual) {
      st.stats.failed_starts++;
      updateStats();
    }
  }, CFG.START_SPIN_SEC * 1000);

  return true;
}

// =============== СТАТИСТИКА И МОТОЧАСЫ =========================
function updateStats() {
  dev[CFG.GEN_VDEV + "/total_starts"] = st.stats.total_starts;
  dev[CFG.GEN_VDEV + "/successful_starts"] = st.stats.successful_starts;
  dev[CFG.GEN_VDEV + "/failed_starts"] = st.stats.failed_starts;
  
  var totalMinutes = st.stats.engine_total_minutes;
  var days = Math.floor(totalMinutes / 1440);
  var hours = Math.floor((totalMinutes % 1440) / 60);
  var minutes = Math.floor(totalMinutes % 60);
  
  dev[CFG.GEN_VDEV + "/engine_days"] = days;
  dev[CFG.GEN_VDEV + "/engine_hours"] = hours;
  dev[CFG.GEN_VDEV + "/engine_minutes"] = minutes;
  dev[CFG.GEN_VDEV + "/engine_total_hours"] = totalMinutes / 60;
}

function startEngineHoursCounter() {
  if (st.timers.engine_hours_counter) {
    gLog("⚠️ Счетчик моточасов уже запущен");
    return;
  }

  st.stats.engine_start_time = Date.now();
  gLog("✓ Счетчик моточасов: ЗАПУЩЕН (обновление каждые " + CFG.ENGINE_HOURS_UPDATE_INTERVAL_SEC + " сек)");
  
  var lastLoggedHour = dev[CFG.GEN_VDEV + "/engine_hours"];
  
  st.timers.engine_hours_counter = setInterval(function() {
    if (st.stats.engine_start_time) {
      var now = Date.now();
      var elapsed_minutes = (now - st.stats.engine_start_time) / 1000 / 60;
      st.stats.engine_total_minutes += elapsed_minutes;
      st.stats.engine_start_time = now;
      
      updateStats();
      
      var currentHour = dev[CFG.GEN_VDEV + "/engine_hours"];
      if (currentHour !== lastLoggedHour) {
        gLog("Моточасы: " + dev[CFG.GEN_VDEV + "/engine_days"] + "д " + 
             currentHour + "ч " + 
             dev[CFG.GEN_VDEV + "/engine_minutes"] + "м");
        lastLoggedHour = currentHour;
      }
    }
  }, CFG.ENGINE_HOURS_UPDATE_INTERVAL_SEC * 1000);
}

function stopEngineHoursCounter() {
  if (st.timers.engine_hours_counter) {
    clearInterval(st.timers.engine_hours_counter);
    st.timers.engine_hours_counter = null;
  }
  
  if (st.stats.engine_start_time) {
    var now = Date.now();
    var elapsed_minutes = (now - st.stats.engine_start_time) / 1000 / 60;
    st.stats.engine_total_minutes += elapsed_minutes;
    st.stats.engine_start_time = null;
    
    updateStats();
    
    gLog("✓ Счетчик моточасов: ОСТАНОВЛЕН. Итого: " + 
         dev[CFG.GEN_VDEV + "/engine_days"] + "д " + 
         dev[CFG.GEN_VDEV + "/engine_hours"] + "ч " + 
         dev[CFG.GEN_VDEV + "/engine_minutes"] + "м (" + 
         dev[CFG.GEN_VDEV + "/engine_total_hours"].toFixed(2) + "ч)");
  }
}

function cancelAutostart(reason) {
  gLog("Автозапуск отменён: " + reason);

  st.canceling_autostart = true;
  st.autostart_in_progress = false;
  st.warmup_in_progress = false;
  st.grid_restored_during_warmup = null;
  stopStarter("автозапуск отменён");
  setChoke(false, "автозапуск отменён");
  clearTimer("warmup");
  clearTimer("warmup_grid_check");
  clearTimer("start_retry");
  setK1(true, "возврат на посёлок после отмены");
  dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";

  setTimeout(function() {
    st.canceling_autostart = false;
  }, 100);
}

// =============== КОНТРОЛЬ ЗАСЛОНКИ =============================
function checkAndCloseChoke() {
  var genRunning = !!dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT];
  var chokeOpen = !!dev[CFG.GEN_RELAY_DEVICE + "/" + CFG.CHOKE_RELAY];

  if (genRunning && chokeOpen) {
    var now = Date.now();

    if (st.choke_opened_at) {
      var openTime = (now - st.choke_opened_at) / 1000;
      if (openTime > CFG.CHOKE_MAX_OPEN_TIME_SEC) {
        gLog("⚠️ Заслонка открыта " + openTime.toFixed(0) + " сек → принудительное закрытие");
        setChoke(false, "тайм-аут открытия");
        st.choke_should_be_closed = true;
      }
    } else {
      gLog("⚠️ Генератор работает, заслонка открыта → закрываем");
      setChoke(false, "генератор работает");
      st.choke_should_be_closed = true;
    }
  }

  if (!genRunning) {
    st.choke_should_be_closed = false;
  }
}

function startChokeMonitor() {
  if (st.timers.choke_monitor) return;

  st.timers.choke_monitor = setInterval(function() {
    checkAndCloseChoke();
  }, CFG.CHOKE_CHECK_INTERVAL_SEC * 1000);

  gLog("Мониторинг заслонки: запущен (проверка каждые " + CFG.CHOKE_CHECK_INTERVAL_SEC + " сек)");
}

function stopChokeMonitor() {
  if (st.timers.choke_monitor) {
    clearInterval(st.timers.choke_monitor);
    st.timers.choke_monitor = null;
    gLog("Мониторинг заслонки: остановлен");
  }
}

// =============== МОНИТОРИНГ VIN И МАСЛА =======================
function updateVin() {
  var val = dev[CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL];
  if (typeof val === "undefined") {
    return;
  }
  var ok = val >= CFG.VIN_MIN;
  if (dev[CFG.GEN_VDEV + "/vin_12v_ok"] !== ok) {
    dev[CFG.GEN_VDEV + "/vin_12v_ok"] = ok;
    gLog("Vin: " + val.toFixed(1) + "В " + (ok ? "✓" : "⚠️"));
  }
}

function updateOilLow() {
  var low = !!dev[CFG.GPIO_DEVICE + "/" + CFG.OIL_INPUT];
  if (dev[CFG.GEN_VDEV + "/oil_low"] !== low) {
    dev[CFG.GEN_VDEV + "/oil_low"] = low;
    if (low) {
      gLog("⚠️ EXT1_IN3 (датчик масла): LOW — блокировка запуска");
    } else {
      gLog("EXT1_IN3 (датчик масла): OK");
    }
  }
}

defineRule("vin_monitor", {
  whenChanged: CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL,
  then: updateVin
});

defineRule("oil_monitor", {
  whenChanged: CFG.GPIO_DEVICE + "/" + CFG.OIL_INPUT,
  then: updateOilLow
});

// =============== МОНИТОРИНГ СЕТИ ===============================
function getVoltageString() {
  var l1 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1];
  var l2 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2];
  var l3 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3];
  return "L1=" + (typeof l1 === "number" ? l1.toFixed(1) : "???") + "В, " +
         "L2=" + (typeof l2 === "number" ? l2.toFixed(1) : "???") + "В, " +
         "L3=" + (typeof l3 === "number" ? l3.toFixed(1) : "???") + "В";
}

function updateGridState(fromInit) {
  var l1 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1];
  var l2 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2];
  var l3 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3];
  if (typeof l1 !== "number" || typeof l2 !== "number" || typeof l3 !== "number") {
    if (!fromInit) {
      gLog("⚠️ Данные счётчика недоступны");
    }
    return st.grid_ok;
  }

  dev[CFG.GEN_VDEV + "/voltage_l1"] = l1;
  dev[CFG.GEN_VDEV + "/voltage_l2"] = l2;
  dev[CFG.GEN_VDEV + "/voltage_l3"] = l3;

  var ok = l1 >= CFG.GRID_V_MIN && l1 <= CFG.GRID_V_MAX &&
           l2 >= CFG.GRID_V_MIN && l2 <= CFG.GRID_V_MAX &&
           l3 >= CFG.GRID_V_MIN && l3 <= CFG.GRID_V_MAX;

  st.grid_ok = ok;
  dev[CFG.GEN_VDEV + "/grid_ok"] = ok;
  return ok;
}

function onGridLost() {
  gLog("Сеть: LOST (" + getVoltageString() + ")");
  dev[CFG.GEN_VDEV + "/status"] = "СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА";

  st.grid_restored_during_warmup = null;
  clearTimer("warmup_grid_check");

  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    gLog("Debounce " + CFG.GRID_FAIL_DEBOUNCE_SEC + " сек");
    clearTimer("grid_fail_debounce");
    st.timers.grid_fail_debounce = setTimeout(function() {
      var stillBad = !updateGridState(false);
      if (stillBad && dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
        gLog("Сеть нестабильна " + CFG.GRID_FAIL_DEBOUNCE_SEC + " сек → автозапуск");
        startAutostart();
      } else if (!stillBad) {
        gLog("Сеть восстановилась во время debounce");
        dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
      }
      st.grid_fail_timestamp = null;
    }, CFG.GRID_FAIL_DEBOUNCE_SEC * 1000);
    st.grid_fail_timestamp = Date.now();
  } else {
    gLog("Автозапуск недоступен (режим/emergency_stop)");
  }
}

function onGridRestored() {
  gLog("Сеть: OK (" + getVoltageString() + ")");

  if (st.grid_fail_timestamp) {
    clearTimer("grid_fail_debounce");
    st.grid_fail_timestamp = null;
    gLog("Debounce отменён");
  }

  if (st.autostart_in_progress) {
    if (st.warmup_in_progress) {
      if (!st.grid_restored_during_warmup) {
        st.grid_restored_during_warmup = Date.now();
        gLog("Сеть восстановилась во время прогрева, проверка " + CFG.WARMUP_GRID_STABLE_SEC + " сек");

        clearTimer("warmup_grid_check");
        st.timers.warmup_grid_check = setTimeout(function() {
          var ok = updateGridState(false);
          if (ok && st.warmup_in_progress) {
            gLog("Сеть стабильна " + CFG.WARMUP_GRID_STABLE_SEC + " сек → отмена автозапуска");
            cancelAutostart("сеть восстановилась и стабильна");
          } else if (!ok) {
            gLog("Сеть снова пропала → продолжаем прогрев");
            st.grid_restored_during_warmup = null;
          }
        }, CFG.WARMUP_GRID_STABLE_SEC * 1000);
      }
    } else if (!st.starter_active) {
      gLog("Сеть восстановилась до запуска генератора");
      cancelAutostart("сеть восстановилась до запуска");
    } else {
      gLog("Сеть восстановилась во время вращения стартера");
    }
    return;
  }

  if (!dev[CFG.GEN_VDEV + "/house_on_gen"]) {
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    setK1(true, "сеть восстановилась");
    return;
  }

  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    startReturnProcedure();
  } else {
    gLog("Возврат недоступен (режим/emergency_stop)");
  }
}

defineRule("grid_monitor", {
  whenChanged: [
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1,
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2,
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3
  ],
  then: function () {
    var prev = st.grid_ok;
    var ok = updateGridState(false);
    if (ok && !prev) {
      onGridRestored();
    } else if (!ok && prev) {
      onGridLost();
    }
  }
});

function scheduleGridCheck() {
  clearTimer("grid_check_interval");
  st.timers.grid_check_interval = setInterval(function () {
    var ok = updateGridState(false);
    if (ok && dev[CFG.GEN_VDEV + "/house_on_gen"] && !st.return_in_progress &&
        dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      startReturnProcedure();
    }
  }, CFG.GRID_CHECK_INTERVAL_SEC * 1000);
}

// =============== СИГНАЛ НАПРЯЖЕНИЯ ОТ ГЕНЕРАТОРА ==============
defineRule("gen_voltage_monitor", {
  whenChanged: CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT,
  then: function (value) {
    st.generator_voltage = !!value;
    if (value) {
      gLog("EXT1_IN6 (напряжение генератора): ON");

      if (!st.timers.engine_hours_counter) {
        startEngineHoursCounter();
      }

      if (!st.timers.choke_monitor) {
        startChokeMonitor();
      }

      if (st.starter_active) {
        st.starter_release_window = true;
        clearTimer("starter_release");
        st.timers.starter_release = setTimeout(function () {
          st.starter_release_window = false;
          stopStarter("генератор завёлся");

          st.stats.successful_starts++;
          updateStats();
        }, CFG.START_RELEASE_DELAY_SEC * 1000);

        clearTimer("choke_close");
        clearTimer("choke_close_manual");
        st.timers.choke_close = setTimeout(function () {
          if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT]) {
            setChoke(false, "закрываем после запуска");
            st.choke_should_be_closed = true;
          }
        }, (CFG.START_RELEASE_DELAY_SEC + CFG.CHOKE_CLOSE_AFTER_RELEASE_SEC) * 1000);
      }

      if (st.autostart_in_progress) {
        startWarmupAndTransfer();
      } else if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" &&
                 !dev[CFG.GEN_VDEV + "/house_on_gen"] &&
                 !st.grid_ok) {
        gLog("Генератор работает, сеть плохая, режим AUTO → переводим дом на генератор");
        st.autostart_in_progress = true;
        startWarmupAndTransfer();
      } else {
        dev[CFG.GEN_VDEV + "/status"] = "Ручной запуск: генератор завёлся";
        clearTimer("choke_close");
        clearTimer("choke_close_manual");
        st.timers.choke_close = setTimeout(function () {
          if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT]) {
            setChoke(false, "закрываем после ручного запуска");
            st.choke_should_be_closed = true;
          }
        }, CFG.CHOKE_CLOSE_AFTER_RELEASE_SEC * 1000);
      }
    } else {
      gLog("EXT1_IN6 (напряжение генератора): OFF");
      st.generator_voltage = false;
      setChoke(false, "генератор не даёт напряжение");

      stopEngineHoursCounter();
      stopChokeMonitor();
    }
  }
});

// =============== АВТОЗАПУСК ===================================
function startAutostart() {
  if (st.autostart_in_progress) {
    gLog("Автозапуск уже выполняется");
    return;
  }
  st.return_in_progress = false;
  st.autostart_in_progress = true;
  st.warmup_in_progress = false;
  st.attempts = 1;
  gLog("СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА (макс. " + CFG.START_ATTEMPTS_MAX + " попыток)");
  gLog("Попытка #" + st.attempts);
  setK1(false, "сеть пропала");
  setChoke(true, "автозапуск");
  startStarter(true, false);
}

function handleStartFailure() {
  if (!st.autostart_in_progress) {
    return;
  }

  st.attempts += 1;

  if (st.attempts > CFG.START_ATTEMPTS_MAX) {
    gLog("❌ Генератор не запущен после " + CFG.START_ATTEMPTS_MAX + " попыток");
    dev[CFG.GEN_VDEV + "/status"] = "Ошибка запуска";
    st.autostart_in_progress = false;
    setChoke(false, "запуск не удался");
    st.stats.failed_starts++;
    updateStats();
    return;
  }

  gLog("Пауза " + CFG.START_REST_SEC + " сек перед попыткой #" + st.attempts);
  clearTimer("starter_spin");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  clearTimer("start_retry");
  st.timers.start_retry = setTimeout(function () {
    if (!st.autostart_in_progress || dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      return;
    }
    var ok = updateGridState(false);
    if (ok) {
      gLog("Сеть восстановилась перед попыткой #" + st.attempts);
      cancelAutostart("сеть восстановилась между попытками");
      return;
    }
    gLog("Попытка #" + st.attempts);
    setChoke(true, "повтор автозапуска");
    startStarter(true, false);
  }, CFG.START_REST_SEC * 1000);
}

function startWarmupAndTransfer() {
  clearTimer("warmup");
  st.warmup_in_progress = true;
  dev[CFG.GEN_VDEV + "/status"] = "Генератор запущен, прогрев";
  gLog("Прогрев " + CFG.WARMUP_SEC + " сек");
  st.timers.warmup = setTimeout(function () {
    if (!st.generator_voltage) {
      gLog("⚠️ Прогрев отменён: генератор заглох");
      dev[CFG.GEN_VDEV + "/status"] = "Генератор заглох во время прогрева";
      st.autostart_in_progress = false;
      st.warmup_in_progress = false;
      if (st.attempts < CFG.START_ATTEMPTS_MAX && dev[CFG.GEN_VDEV + "/mode"] === "AUTO") {
        clearTimer("start_retry");
        st.timers.start_retry = setTimeout(function () {
          if (!st.generator_voltage && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
            st.autostart_in_progress = true;
            handleStartFailure();
          }
        }, CFG.START_REST_SEC * 1000);
      }
      return;
    }
    setk2(true, "дом на генераторе");
    setK1(false, "переход на генератор");
    dev[CFG.GEN_VDEV + "/house_on_gen"] = true;
    dev[CFG.GEN_VDEV + "/status"] = "Дом на генераторе";
    gLog("Дом переведён на генератор");
    st.autostart_in_progress = false;
    st.warmup_in_progress = false;
    st.grid_restored_during_warmup = null;
    clearTimer("warmup_grid_check");
    scheduleGridCheck();
  }, CFG.WARMUP_SEC * 1000);
}

// =============== ВОЗВРАТ НА СЕТЬ ===============================
function startReturnProcedure() {
  if (st.return_in_progress) {
    gLog("Возврат уже выполняется");
    return;
  }
  st.return_in_progress = true;
  dev[CFG.GEN_VDEV + "/status"] = "Возврат на посёлок (" + CFG.RETURN_WAIT_SEC + " с)";
  gLog("Возврат на посёлок (" + getVoltageString() + ")");
  clearTimer("return_wait");
  st.timers.return_wait = setTimeout(function () {
    var ok = updateGridState(false);
    if (!ok) {
      gLog("⚠️ Возврат отменён: сеть снова вне нормы (" + getVoltageString() + ")");
      dev[CFG.GEN_VDEV + "/status"] = "Дом на генераторе (сеть нестабильна)";
      st.return_in_progress = false;
      return;
    }
    performReturnSwitch();
  }, CFG.RETURN_WAIT_SEC * 1000);
}

function performReturnSwitch() {
  gLog("Сеть стабильна → переключаем на посёлок (" + getVoltageString() + ")");
  setK1(true, "возврат на посёлок");
  dev[CFG.GEN_VDEV + "/house_on_gen"] = false;

  clearTimer("stop_pulse");
  setStopRelay(true, "возврат на посёлок");
  st.timers.stop_pulse = setTimeout(function () {
    setStopRelay(false, "завершение глушения");
  }, CFG.STOP_PULSE_SEC * 1000);

  clearTimer("k2_off_delay");
  st.timers.k2_off_delay = setTimeout(function () {
    setk2(false, "отключение генератора после возврата");
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    st.return_in_progress = false;
  }, CFG.k2_OFF_AFTER_RETURN_SEC * 1000);
}

// =============== РЕЖИМЫ И РУЧНОЙ РЕЖИМ ========================
defineRule("mode_change", {
  whenChanged: CFG.GEN_VDEV + "/mode",
  then: function (newValue) {
    var mode = newValue === "MANUAL" ? "MANUAL" : "AUTO";
    dev[CFG.GEN_VDEV + "/mode"] = mode;
    dev[CFG.GEN_VDEV + "/mode_auto"] = mode === "AUTO";
    gLog("Режим: " + mode);
    clearAllTimers();
    st.autostart_in_progress = false;
    st.warmup_in_progress = false;
    st.return_in_progress = false;
    st.grid_fail_timestamp = null;
    st.grid_restored_during_warmup = null;
    st.manual_start_in_progress = false;

    if (mode === "AUTO") {
      if (dev[CFG.GEN_VDEV + "/house_on_gen"]) {
        gLog("Дом на генераторе → запуск мониторинга сети");
        scheduleGridCheck();
      } else {
        var ok = updateGridState(false);
        if (!ok && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
          gLog("Сеть вне нормы при переключении в AUTO → запуск генератора");
          onGridLost();
        } else if (ok) {
          gLog("Сеть в норме");
          dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
        } else {
          gLog("Автозапуск недоступен: emergency_stop активен");
        }
      }
    }
  }
});

defineRule("mode_auto_toggle", {
  whenChanged: CFG.GEN_VDEV + "/mode_auto",
  then: function (newValue) {
    dev[CFG.GEN_VDEV + "/mode"] = newValue ? "AUTO" : "MANUAL";
  }
});

defineRule("manual_k1", {
  whenChanged: CFG.GEN_VDEV + "/manual_k1_grid",
  then: function (val) {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      dev[CFG.GEN_VDEV + "/manual_k1_grid"] = readContactor(CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1, CFG.GRID_RELAY_INVERTED);
      return;
    }
    setK1(!!val, "ручное управление");
  }
});

defineRule("manual_k2", {
  whenChanged: CFG.GEN_VDEV + "/manual_k2_gen",
  then: function (val) {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      dev[CFG.GEN_VDEV + "/manual_k2_gen"] = readContactor(CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K2, CFG.GEN_RELAY_INVERTED);
      return;
    }
    setk2(!!val, "ручное управление");
  }
});

defineRule("manual_start", {
  whenChanged: CFG.GEN_VDEV + "/manual_start",
  then: function () {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("⚠️ manual_start доступен только в MANUAL режиме");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      gLog("⚠️ Ручной запуск заблокирован: emergency_stop");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/oil_low"]) {
      gLog("⚠️ Ручной запуск заблокирован: низкий уровень масла");
      return;
    }

    gLog("Ручной запуск: попытка");
    setChoke(true, "ручной запуск");
    startStarter(false, true);
  }
});

// =============== АВАРИЙНЫЙ СТОП ================================
defineRule("emergency_stop", {
  whenChanged: CFG.GEN_VDEV + "/emergency_stop",
  then: function (val) {
    if (val) {
      gLog("⚠️⚠️⚠️ EMERGENCY STOP АКТИВИРОВАН");
      st.autostart_in_progress = false;
      st.warmup_in_progress = false;
      st.return_in_progress = false;
      st.grid_fail_timestamp = null;
      st.grid_restored_during_warmup = null;
      st.manual_start_in_progress = false;
      clearAllTimers();
      stopStarter("emergency_stop");
      setChoke(false, "emergency_stop");
      setStopRelay(true, "emergency_stop");
      clearTimer("stop_pulse");
      st.timers.stop_pulse = setTimeout(function () {
        setStopRelay(false, "сброс после emergency_stop");
      }, CFG.STOP_PULSE_SEC * 1000);
      dev[CFG.GEN_VDEV + "/status"] = "Аварийный стоп";
    } else {
      gLog("Emergency stop сброшен");
    }
  }
});

// =============== TELEGRAM УПРАВЛЕНИЕ ===========================
defineRule("telegram_toggle", {
  whenChanged: CFG.GEN_VDEV + "/telegram_enabled",
  then: function (val) {
    if (val) {
      gLog("📱 Telegram уведомления: ВКЛЮЧЕНЫ");
    } else {
      log("Генератор: 📱 Telegram уведомления: ВЫКЛЮЧЕНЫ");
    }
  }
});

// =============== ОТСЛЕЖИВАНИЕ ВНЕШНИХ ВКЛЮЧЕНИЙ ===============
defineRule("starter_external", {
  whenChanged: CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY,
  then: function (val) {
    if (val && !st.starter_active) {
      gLog("⚠️ Внешнее включение K1 (стартер) обнаружено → принудительное отключение");
      stopStarter("внешнее вмешательство");
    }
  }
});

defineRule("stop_relay_monitor", {
  whenChanged: CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY,
  then: function (val) {
    if (val) {
      gLog("K2 (глушение) включено → стартер принудительно отключён");
      stopStarter("K2 активен");
    }
  }
});

defineRule("sync_k1_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1,
  then: function (value) {
    var relayOn = !!value;
    var on = CFG.GRID_RELAY_INVERTED ? !relayOn : relayOn;
    dev[CFG.GEN_VDEV + "/manual_k1_grid"] = on;
  }
});

defineRule("sync_k2_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K2,
  then: function (value) {
    var relayOn = !!value;
    var on = CFG.GEN_RELAY_INVERTED ? !relayOn : relayOn;
    dev[CFG.GEN_VDEV + "/manual_k2_gen"] = on;
    dev[CFG.GEN_VDEV + "/house_on_gen"] = on;
  }
});

// =============== ЛОГИРОВАНИЕ ВХОДОВ ============================
defineRule("log_choke", {
  whenChanged: CFG.GEN_RELAY_DEVICE + "/" + CFG.CHOKE_RELAY,
  then: function (val) {
    if (!st.starter_active && !st.manual_start_in_progress) {
      gLog("⚠️ Внешнее изменение K3 (заслонка): " + (val ? "OPEN" : "CLOSED"));
    }
  }
});

defineRule("log_k1_external", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1,
  then: function (val) {
    if (!st.autostart_in_progress && !st.return_in_progress &&
        !st.canceling_autostart &&
        dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      var relayOn = !!val;
      var on = CFG.GRID_RELAY_INVERTED ? !relayOn : relayOn;
      gLog("⚠️ Внешнее изменение К1 (посёлок): " + (on ? "ON" : "OFF"));
    }
  }
});

defineRule("log_k2_external", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K2,
  then: function (val) {
    if (!st.autostart_in_progress && !st.return_in_progress &&
        !st.canceling_autostart &&
        dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      var relayOn = !!val;
      var on = CFG.GEN_RELAY_INVERTED ? !relayOn : relayOn;
      gLog("⚠️ Внешнее изменение К2 (генератор): " + (on ? "ON" : "OFF"));
    }
  }
});

// =============== ИНИЦИАЛИЗАЦИЯ ================================
defineRule("gen_init", {
  asSoonAs: function () { return true; },
  then: function () {
    gLog("=== ИНИЦИАЛИЗАЦИЯ СИСТЕМЫ ===");
    updateVin();
    updateOilLow();
    updateGridState(true);

    var k1 = readContactor(CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1, CFG.GRID_RELAY_INVERTED);
    var k2 = readContactor(CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K2, CFG.GEN_RELAY_INVERTED);
    dev[CFG.GEN_VDEV + "/manual_k1_grid"] = k1;
    dev[CFG.GEN_VDEV + "/manual_k2_gen"] = k2;
    dev[CFG.GEN_VDEV + "/house_on_gen"] = k2;

    if (st.grid_ok) {
      setK1(true, "инициализация, сеть в норме");
      setk2(false, "инициализация, сеть в норме");
      dev[CFG.GEN_VDEV + "/house_on_gen"] = false;
      dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    } else {
      dev[CFG.GEN_VDEV + "/status"] = "Сеть вне нормы при старте, дом на текущем источнике";
    }

    gLog("Режим: " + dev[CFG.GEN_VDEV + "/mode"]);
    gLog("К1 (посёлок): " + (k1 ? "ON" : "OFF"));
    gLog("К2 (генератор): " + (k2 ? "ON" : "OFF"));
    gLog("Сеть: " + (st.grid_ok ? "OK" : "LOST"));

    var genRunning = !!dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT];
    if (genRunning) {
      gLog("Генератор работает при старте → запуск мониторинга");
      startChokeMonitor();
      checkAndCloseChoke();
      startEngineHoursCounter();
    }

    gLog("=== ИНИЦИАЛИЗАЦИЯ ЗАВЕРШЕНА ===");
    
    if (CFG.TELEGRAM_ENABLED && dev[CFG.GEN_VDEV + "/telegram_enabled"]) {
      gLog("📱 Telegram уведомления активны");
    }
  }
});
