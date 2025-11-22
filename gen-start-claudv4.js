// Управление генератором и вводами (wb-rules)

// =============== КОНФИГУРАЦИЯ ==================================
var CFG = {
  GEN_VDEV: "gen_virtual",

  GEN_RELAY_DEVICE: "wb-mr6c_76",
  CONTACTOR_DEVICE: "wb-mr6c_39",
  GPIO_DEVICE: "wb-gpio",
  VIN_DEVICE: "power_status",
  VIN_CONTROL: "Vin",

  OIL_INPUT: "EXT1_IN3",
  GEN_VOLTAGE_INPUT: "EXT1_IN6",

  STARTER_RELAY: "K1",
  STOP_RELAY: "K2",
  CHOKE_RELAY: "K3",

  GRID_K1: "K1",
  GEN_K4: "K4",

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
  WARMUP_GRID_STABLE_SEC: 10,  // Новый: стабильность сети во время прогрева

  RETURN_WAIT_SEC: 20,
  K4_OFF_AFTER_RETURN_SEC: 5,
  STOP_PULSE_SEC: 10,

  GRID_CHECK_INTERVAL_SEC: 30,
  GRID_FAIL_DEBOUNCE_SEC: 3,

  VIN_MIN: 11.0
};

// =============== СОСТОЯНИЕ =====================================
var st = {
  grid_ok: false,
  generator_voltage: false,
  autostart_in_progress: false,
  return_in_progress: false,
  warmup_in_progress: false,      // Новый флаг
  attempts: 0,
  starter_active: false,
  starter_release_window: false,
  grid_fail_timestamp: null,
  grid_restored_during_warmup: null,  // Новый: отметка времени восстановления сети
  timers: {
    starter_spin: null,
    starter_watchdog: null,
    starter_release: null,
    choke_close: null,
    choke_close_manual: null,
    warmup: null,
    warmup_grid_check: null,    // Новый таймер
    return_wait: null,
    stop_pulse: null,
    k4_off_delay: null,
    grid_check_interval: null,
    start_retry: null,
    grid_fail_debounce: null
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
    manual_k4_gen: { type: "switch", value: false },
    manual_start: { type: "pushbutton" },
    emergency_stop: { type: "switch", value: false }
  }
});

// =============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =======================
function gLog(msg) {
  log("Генератор: " + msg);
}

function clearTimer(name) {
  if (st.timers[name]) {
    clearTimeout(st.timers[name]);
    clearInterval(st.timers[name]);
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
  clearTimer("k4_off_delay");
  clearTimer("grid_check_interval");
  clearTimer("start_retry");
  clearTimer("grid_fail_debounce");
}

function setK1(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1;
  if (dev[path] !== on) {
    dev[path] = on;
    gLog("Состояние контактора К1 (посёлок): " + (on ? "включен" : "выключен") +
         (reason ? " (" + reason + ")" : ""));
  }
}

function setK4(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4;
  if (dev[path] !== on) {
    dev[path] = on;
    gLog("Состояние контактора К4 (генератор): " + (on ? "включен" : "выключен") +
         (reason ? " (" + reason + ")" : ""));
  }
}

function setChoke(open, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.CHOKE_RELAY;
  if (dev[path] !== open) {
    dev[path] = open;
    gLog("Заслонка " + (open ? "открыта" : "закрыта") + (reason ? " (" + reason + ")" : ""));
  }
}

function setStopRelay(on, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY;
  if (dev[path] !== on) {
    dev[path] = on;
    gLog("Реле глушения " + (on ? "включено" : "выключено") + (reason ? " (" + reason + ")" : ""));
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
    gLog("Стартер отключён" + (reason ? " (" + reason + ")" : ""));
  }
}

function startStarter(allowRetry) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY;
  if (st.starter_active) {
    gLog("Стартер уже активен, включение игнорируется");
    return false;
  }
  if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    gLog("Стартер не включаем: аварийный стоп активен");
    return false;
  }
  if (dev[CFG.GEN_VDEV + "/oil_low"]) {
    gLog("Стартер не включаем: низкий уровень масла");
    return false;
  }
  if (dev[CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY]) {
    gLog("Стартер не включаем: реле глушения активно");
    return false;
  }
  if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT] && !st.starter_release_window) {
    gLog("Стартер не включаем: генератор уже даёт напряжение");
    return false;
  }

  st.starter_active = true;
  st.starter_release_window = false;
  dev[path] = true;
  gLog("Стартер включён");

  clearTimer("starter_watchdog");
  st.timers.starter_watchdog = setTimeout(function () {
    if (st.starter_active) {
      stopStarter("стартер работал слишком долго");
      if (allowRetry && st.autostart_in_progress) {
        handleStartFailure();
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
    stopStarter("генератор не запущен за " + CFG.START_SPIN_SEC + " с");
    if (allowRetry && st.autostart_in_progress) {
      handleStartFailure();
    }
  }, CFG.START_SPIN_SEC * 1000);

  return true;
}

// =============== ОТМЕНА АВТОЗАПУСКА ============================
function cancelAutostart(reason) {
  gLog("Автозапуск отменён: " + reason);
  st.autostart_in_progress = false;
  st.warmup_in_progress = false;
  st.grid_restored_during_warmup = null;
  stopStarter("автозапуск отменён");
  setChoke(false, "автозапуск отменён");
  clearTimer("warmup");
  clearTimer("warmup_grid_check");
  clearTimer("start_retry");
  setK1(true, "возврат на посёлок после отмены автозапуска");
  dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
}

// =============== МОНИТОРИНГ VIN И МАСЛА =======================
function updateVin() {
  var val = dev[CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL];
  if (typeof val === "undefined") {
    return;
  }
  dev[CFG.GEN_VDEV + "/vin_12v_ok"] = val >= CFG.VIN_MIN;
}

function updateOilLow() {
  var low = !!dev[CFG.GPIO_DEVICE + "/" + CFG.OIL_INPUT];
  dev[CFG.GEN_VDEV + "/oil_low"] = low;
  if (low) {
    gLog("Низкий уровень масла — блокировка запуска");
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
  gLog("Напряжение посёлка вне нормы или отсутствует (" + getVoltageString() + ")");
  dev[CFG.GEN_VDEV + "/status"] = "СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА";
  
  // Сбрасываем отметку восстановления сети во время прогрева
  st.grid_restored_during_warmup = null;
  clearTimer("warmup_grid_check");
  
  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    // Запускаем debounce таймер
    gLog("Ожидание " + CFG.GRID_FAIL_DEBOUNCE_SEC + " сек перед автозапуском (защита от просадок)");
    clearTimer("grid_fail_debounce");
    st.timers.grid_fail_debounce = setTimeout(function() {
      // Проверяем, что сеть всё ещё плохая
      var stillBad = !updateGridState(false);
      if (stillBad && dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
        gLog("Сеть нестабильна " + CFG.GRID_FAIL_DEBOUNCE_SEC + " сек, запускаем автозапуск");
        startAutostart();
      } else if (!stillBad) {
        gLog("Сеть восстановилась во время ожидания, автозапуск отменён");
        dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
      }
      st.grid_fail_timestamp = null;
    }, CFG.GRID_FAIL_DEBOUNCE_SEC * 1000);
    st.grid_fail_timestamp = Date.now();
  } else {
    gLog("Автозапуск не выполняется (режим не AUTO или аварийный стоп)");
  }
}

function onGridRestored() {
  gLog("Напряжение посёлка в норме (" + getVoltageString() + ")");
  
  // Отменяем debounce если он активен
  if (st.grid_fail_timestamp) {
    clearTimer("grid_fail_debounce");
    st.grid_fail_timestamp = null;
    gLog("Отменён таймер debounce — сеть восстановилась");
  }
  
  // ГИБРИДНАЯ ЛОГИКА: проверяем фазу автозапуска
  if (st.autostart_in_progress) {
    if (st.warmup_in_progress) {
      // Во время прогрева — запускаем проверку стабильности
      if (!st.grid_restored_during_warmup) {
        st.grid_restored_during_warmup = Date.now();
        gLog("Сеть восстановилась во время прогрева, проверка стабильности " + 
             CFG.WARMUP_GRID_STABLE_SEC + " сек");
        
        clearTimer("warmup_grid_check");
        st.timers.warmup_grid_check = setTimeout(function() {
          var ok = updateGridState(false);
          if (ok && st.warmup_in_progress) {
            gLog("Сеть стабильна " + CFG.WARMUP_GRID_STABLE_SEC + " сек во время прогрева, отменяем автозапуск");
            cancelAutostart("сеть восстановилась и стабильна");
          } else if (!ok) {
            gLog("Сеть снова пропала, продолжаем прогрев");
            st.grid_restored_during_warmup = null;
          }
        }, CFG.WARMUP_GRID_STABLE_SEC * 1000);
      }
    } else if (!st.starter_active) {
      // До начала вращения стартера или между попытками — отменяем сразу
      gLog("Сеть восстановилась до запуска генератора");
      cancelAutostart("сеть восстановилась до запуска");
    } else {
      // Стартер крутится — даём завершить попытку
      gLog("Сеть восстановилась во время вращения стартера, попытка будет завершена");
    }
    return;
  }
  
  // Штатная логика для работающего генератора
  if (!dev[CFG.GEN_VDEV + "/house_on_gen"]) {
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    setK1(true, "сеть восстановилась, дом уже на посёлке");
    return;
  }
  
  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" && !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    startReturnProcedure();
  } else {
    gLog("Возврат на посёлок не запускаем (режим не AUTO или авария)");
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

// периодическая проверка сети при питании от генератора
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
      gLog("Обнаружено напряжение от генератора");
      if (st.starter_active) {
        st.starter_release_window = true;
        clearTimer("starter_release");
        st.timers.starter_release = setTimeout(function () {
          st.starter_release_window = false;
          stopStarter("генератор завёлся");
        }, CFG.START_RELEASE_DELAY_SEC * 1000);
        clearTimer("choke_close");
        clearTimer("choke_close_manual");
        st.timers.choke_close = setTimeout(function () {
          setChoke(false, "закрываем заслонку после запуска");
        }, (CFG.START_RELEASE_DELAY_SEC + CFG.CHOKE_CLOSE_AFTER_RELEASE_SEC) * 1000);
      }
      if (st.autostart_in_progress) {
        startWarmupAndTransfer();
      } else {
        dev[CFG.GEN_VDEV + "/status"] = "Ручной запуск: генератор завёлся";
      }
    } else {
      st.generator_voltage = false;
      setChoke(false, "генератор не даёт напряжение");
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
  gLog("СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА");
  gLog("Попытка запуска #" + st.attempts);
  setK1(false, "сеть пропала");
  setChoke(true, "автозапуск");
  startStarter(true);
}

function handleStartFailure() {
  if (!st.autostart_in_progress) {
    return;
  }
  st.attempts += 1;
  if (st.attempts > CFG.START_ATTEMPTS_MAX) {
    gLog("Генератор не запущен после " + CFG.START_ATTEMPTS_MAX + " попыток");
    dev[CFG.GEN_VDEV + "/status"] = "Ошибка запуска";
    st.autostart_in_progress = false;
    setChoke(false, "запуск не удался");
    return;
  }
  gLog("Генератор не запустился, даём стартеру отдохнуть " + CFG.START_REST_SEC + " с");
  clearTimer("starter_spin");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  clearTimer("start_retry");
  st.timers.start_retry = setTimeout(function () {
    if (!st.autostart_in_progress || dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      return;
    }
    // Проверяем сеть перед повторной попыткой
    var ok = updateGridState(false);
    if (ok) {
      gLog("Сеть восстановилась перед попыткой #" + st.attempts + ", отменяем автозапуск");
      cancelAutostart("сеть восстановилась между попытками");
      return;
    }
    gLog("Попытка запуска #" + st.attempts);
    setChoke(true, "повтор автозапуска");
    startStarter(true);
  }, CFG.START_REST_SEC * 1000);
}

function startWarmupAndTransfer() {
  clearTimer("warmup");
  st.warmup_in_progress = true;
  dev[CFG.GEN_VDEV + "/status"] = "Генератор запущен, прогрев";
  gLog("Генератор запущен, прогрев " + CFG.WARMUP_SEC + " с");
  st.timers.warmup = setTimeout(function () {
    if (!st.generator_voltage) {
      gLog("Прогрев отменён: сигнал генератора пропал");
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
    setK4(true, "дом на генераторе");
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
  gLog("Возврат на посёлок запущен (" + getVoltageString() + ")");
  clearTimer("return_wait");
  st.timers.return_wait = setTimeout(function () {
    var ok = updateGridState(false);
    if (!ok) {
      gLog("Возврат отменён — напряжение снова вне нормы (" + getVoltageString() + ")");
      dev[CFG.GEN_VDEV + "/status"] = "Дом на генераторе (сеть нестабильна)";
      st.return_in_progress = false;
      return;
    }
    performReturnSwitch();
  }, CFG.RETURN_WAIT_SEC * 1000);
}

function performReturnSwitch() {
  gLog("Сеть стабильна, переключаем дом на посёлок (" + getVoltageString() + ")");
  setK1(true, "возврат на посёлок");
  dev[CFG.GEN_VDEV + "/house_on_gen"] = false;

  clearTimer("stop_pulse");
  setStopRelay(true, "возврат на посёлок");
  st.timers.stop_pulse = setTimeout(function () {
    setStopRelay(false, "завершение глушения");
  }, CFG.STOP_PULSE_SEC * 1000);

  clearTimer("k4_off_delay");
  st.timers.k4_off_delay = setTimeout(function () {
    setK4(false, "отключение генератора после возврата");
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    st.return_in_progress = false;
  }, CFG.K4_OFF_AFTER_RETURN_SEC * 1000);
}

// =============== РЕЖИМЫ И РУЧНОЙ РЕЖИМ ========================
defineRule("mode_change", {
  whenChanged: CFG.GEN_VDEV + "/mode",
  then: function (newValue) {
    var mode = newValue === "MANUAL" ? "MANUAL" : "AUTO";
    dev[CFG.GEN_VDEV + "/mode"] = mode;
    dev[CFG.GEN_VDEV + "/mode_auto"] = mode === "AUTO";
    gLog("Режим изменён на " + mode);
    clearAllTimers();
    st.autostart_in_progress = false;
    st.warmup_in_progress = false;
    st.return_in_progress = false;
    st.grid_fail_timestamp = null;
    st.grid_restored_during_warmup = null;
    if (mode === "AUTO" && dev[CFG.GEN_VDEV + "/house_on_gen"]) {
      scheduleGridCheck();
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
      gLog("manual_k1_grid изменён не в MANUAL, игнорирую");
      dev[CFG.GEN_VDEV + "/manual_k1_grid"] = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1];
      return;
    }
    setK1(!!val, "ручное управление");
  }
});

defineRule("manual_k4", {
  whenChanged: CFG.GEN_VDEV + "/manual_k4_gen",
  then: function (val) {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("manual_k4_gen изменён не в MANUAL, игнорирую");
      dev[CFG.GEN_VDEV + "/manual_k4_gen"] = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4];
      return;
    }
    setK4(!!val, "ручное управление");
  }
});

defineRule("manual_start", {
  whenChanged: CFG.GEN_VDEV + "/manual_start",
  then: function () {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("manual_start изменён не в MANUAL, игнорирую");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      gLog("Ручной запуск заблокирован аварийным стопом");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/oil_low"]) {
      gLog("Ручной запуск невозможен: низкий уровень масла");
      return;
    }
    gLog("Ручной запуск: одна попытка");
    setChoke(true, "ручной запуск");
    startStarter(false);
    clearTimer("choke_close");
    clearTimer("choke_close_manual");
    st.timers.choke_close_manual = setTimeout(function () {
      if (!dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT] && !st.starter_active) {
        setChoke(false, "закрываем заслонку после ручной попытки");
      }
    }, (CFG.START_SPIN_SEC + CFG.CHOKE_CLOSE_AFTER_RELEASE_SEC) * 1000);
  }
});

// =============== АВАРИЙНЫЙ СТОП ================================
defineRule("emergency_stop", {
  whenChanged: CFG.GEN_VDEV + "/emergency_stop",
  then: function (val) {
    if (val) {
      gLog("Установлен emergency_stop — все процедуры прерваны");
      st.autostart_in_progress = false;
      st.warmup_in_progress = false;
      st.return_in_progress = false;
      st.grid_fail_timestamp = null;
      st.grid_restored_during_warmup = null;
      clearAllTimers();
      stopStarter("аварийный стоп");
      setChoke(false, "аварийный стоп");
      setStopRelay(true, "аварийный стоп");
      clearTimer("stop_pulse");
      st.timers.stop_pulse = setTimeout(function () {
        setStopRelay(false, "сброс стоп-реле после аварии");
      }, CFG.STOP_PULSE_SEC * 1000);
      dev[CFG.GEN_VDEV + "/status"] = "Аварийный стоп";
    } else {
      gLog("Сброшен emergency_stop");
    }
  }
});

// =============== ОТСЛЕЖИВАНИЕ ВНЕШНИХ ВКЛЮЧЕНИЙ ===============
defineRule("starter_external", {
  whenChanged: CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY,
  then: function (val) {
    if (val && !st.starter_active) {
      gLog("Обнаружено внешнее включение стартера, отключаем");
      stopStarter("внешнее вмешательство");
    }
  }
});

defineRule("stop_relay_monitor", {
  whenChanged: CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY,
  then: function (val) {
    if (val) {
      gLog("Реле глушения включено — стартер принудительно отключен");
      stopStarter("стоп активен");
    }
  }
});

defineRule("sync_k1_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1,
  then: function (value) {
    dev[CFG.GEN_VDEV + "/manual_k1_grid"] = !!value;
  }
});

defineRule("sync_k4_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4,
  then: function (value) {
    var on = !!value;
    dev[CFG.GEN_VDEV + "/manual_k4_gen"] = on;
    dev[CFG.GEN_VDEV + "/house_on_gen"] = on;
  }
});

// =============== ИНИЦИАЛИЗАЦИЯ ================================
defineRule("gen_init", {
  asSoonAs: function () { return true; },
  then: function () {
    gLog("Инициализация логики генератора");
    updateVin();
    updateOilLow();
    updateGridState(true);

    var k1 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1];
    var k4 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4];
    dev[CFG.GEN_VDEV + "/manual_k1_grid"] = k1;
    dev[CFG.GEN_VDEV + "/manual_k4_gen"] = k4;
    dev[CFG.GEN_VDEV + "/house_on_gen"] = k4;

    if (st.grid_ok) {
      setK1(true, "инициализация, сеть в норме");
      setK4(false, "инициализация, сеть в норме");
      dev[CFG.GEN_VDEV + "/house_on_gen"] = false;
      dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    } else {
      dev[CFG.GEN_VDEV + "/status"] = "Сеть вне нормы при старте, дом на текущем источнике";
    }

    gLog("Инициализация завершена, режим: " + dev[CFG.GEN_VDEV + "/mode"]);
  }
});
