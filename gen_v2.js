// gen v2 (доработанный)
// ========= КОНФИГУРАЦИЯ =======================================

var CFG = {
  GEN_VDEV:           "gen_virtual",

  GEN_RELAY_DEVICE:   "wb-mr6c_76",   // реле стартера / заслонки / глушения
  CONTACTOR_DEVICE:   "wb-mr6c_39",   // контакторы ввода
  GPIO_DEVICE:        "wb-gpio",
  VIN_DEVICE:         "power_status",
  VIN_CONTROL:        "Vin",

  OIL_INPUT:          "EXT1_IN3",     // низкий уровень масла (замкнуто = авария)
  GEN_VOLTAGE_INPUT:  "EXT1_IN6",     // есть напряжение от генератора

  CHOKE_RELAY:        "K3",           // заслонка
  STARTER_RELAY:      "K1",           // стартер
  STOP_RELAY:         "K2",           // глушение

  GRID_K1:            "K1",           // контактор посёлка
  GEN_K4:             "K4",           // контактор генератора

  GRID_METER_DEVICE:  "wb-map3et_90",
  GRID_V_L1:          "Urms L1",
  GRID_V_L2:          "Urms L2",
  GRID_V_L3:          "Urms L3",

  GRID_V_MIN:         175,
  GRID_V_MAX:         255,

  GRID_FAIL_DEBOUNCE_MS: 3000,        // сеть считаем «реально пропавшей», если она вне нормы дольше этого времени

  VIN_MIN:            11.0,           // 12 В "в норме" выше порога

  MAX_ATTEMPTS:       4,
  CRANK_TIME_MS:      7000,           // 7 c "крутим" стартер
  REST_AFTER_FAIL_MS: 5000,           // 5 c пауза между попытками
  STARTER_MAX_MS:     10000,          // максимум 10 c при любых условиях
  STARTER_RELEASE_MS: 500,            // отпускаем стартер через 0.5 c после появления напряжения
  CHOKE_CLOSE_MS:     5000,           // закрываем заслонку через 5 c после отпускания стартера

  WARMUP_MS:          30000,          // прогрев генератора до включения К4
  RETURN_WAIT_MS:     20000,          // ожидание стабильной сети перед возвратом
  STOP_PULSE_MS:      10000,          // импульс на глушение
  K4_OFF_AFTER_RETURN_MS: 5000        // задержка отключения К4 после возврата
};

// ========= СОСТОЯНИЕ ==========================================

var st = {
  grid_ok:             false,
  last_voltages:       [0, 0, 0],

  autostart_in_progress: false,
  return_in_progress:     false,
  attempts:               0,

  starter_active:         false,
  starter_from_autostart: false,
  starter_started_at:     0,

  generator_running:      false,

  timers: {
    starter_attempt:      null,
    starter_watchdog:     null,
    starter_release:      null,
    choke_close:          null,
    warmup:               null,
    return_wait:          null,
    stop_pulse:           null,
    k4_off_delay:         null,
    choke_close_manual:   null,
    grid_fail_debounce:   null
  }
};

// ========= ВИРТУАЛЬНОЕ УСТРОЙСТВО =============================

defineVirtualDevice(CFG.GEN_VDEV, {
  title: { ru: "Генератор", en: "Generator" },
  cells: {
    mode: {
      title: { ru: "Режим", en: "Mode" },
      type: "text",
      value: "AUTO",
      enum: {
        "AUTO":   { ru: "Авто",   en: "AUTO" },
        "MANUAL": { ru: "Ручной", en: "MANUAL" }
      }
    },
    status: {
      title: { ru: "Статус", en: "Status" },
      type: "text",
      value: "Инициализация"
    },
    mode_auto: {
      type: "switch",
      value: true  // AUTO по умолчанию
    },
    grid_ok: {
      title: { ru: "Сеть в норме", en: "Grid OK" },
      type: "switch",
      value: false,
      readonly: true
    },
    house_on_gen: {
      title: { ru: "Дом на генераторе", en: "House on generator" },
      type: "switch",
      value: false,
      readonly: true
    },
    k1_grid_state: {
      title: { ru: "Контактор К1 (посёлок)", en: "Contactor K1 (grid)" },
      type: "switch",
      value: false,
      readonly: true
    },
    k4_gen_state: {
      title: { ru: "Контактор К4 (генератор)", en: "Contactor K4 (gen)" },
      type: "switch",
      value: false,
      readonly: true
    },
    oil_low: {
      title: { ru: "Низкий уровень масла", en: "Oil low" },
      type: "switch",
      value: false,
      readonly: true
    },
    vin_12v_ok: {
      title: { ru: "Питание 12 В", en: "12V VIN OK" },
      type: "switch",
      value: false,
      readonly: true
    },
    voltage_l1: {
      title: { ru: "U L1", en: "U L1" },
      type: "value",
      value: 0,
      precision: 1
    },
    voltage_l2: {
      title: { ru: "U L2", en: "U L2" },
      type: "value",
      value: 0,
      precision: 1
    },
    voltage_l3: {
      title: { ru: "U L3", en: "U L3" },
      type: "value",
      value: 0,
      precision: 1
    },

    manual_k1_grid: {
      title: { ru: "Ручной К1 (посёлок)", en: "Manual K1 (grid)" },
      type: "switch",
      value: false
    },
    manual_k4_gen: {
      title: { ru: "Ручной К4 (генератор)", en: "Manual K4 (gen)" },
      type: "switch",
      value: false
    },
    manual_start: {
      title: { ru: "Ручной запуск (1 попытка)", en: "Manual start (one attempt)" },
      type: "pushbutton"
    },
    emergency_stop: {
      title: { ru: "Аварийный стоп", en: "Emergency stop" },
      type: "switch",
      value: false
    }
  }
});

// ========= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============================

function gLog(msg) {
  log("Генератор: " + msg);
}

function clearTimer(name) {
  if (st.timers[name]) {
    clearTimeout(st.timers[name]);
    st.timers[name] = null;
  }
}

function clearAllTimers() {
  clearTimer("starter_attempt");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  clearTimer("choke_close");
  clearTimer("warmup");
  clearTimer("return_wait");
  clearTimer("stop_pulse");
  clearTimer("k4_off_delay");
  clearTimer("choke_close_manual");
}

// ----- реле и контакторы --------------------------------------

function setK1(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1;
  if (dev[path] === on) {
    return;
  }
  dev[path] = on;
  dev[CFG.GEN_VDEV + "/k1_grid_state"] = !!on;
  gLog("К1 (посёлок) -> " + (on ? "ВКЛ" : "ВЫКЛ") + (reason ? " (" + reason + ")" : ""));
}

function setK4(on, reason) {
  var path = CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4;
  if (dev[path] === on) {
    return;
  }
  dev[path] = on;
  dev[CFG.GEN_VDEV + "/k4_gen_state"] = !!on;
  gLog("К4 (генератор) -> " + (on ? "ВКЛ" : "ВЫКЛ") + (reason ? " (" + reason + ")" : ""));
}

function setChoke(open, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.CHOKE_RELAY;
  if (dev[path] === open) {
    return;
  }
  dev[path] = open;
  gLog("Заслонка " + (open ? "ОТКРЫТА" : "ЗАКРЫТА") + (reason ? " (" + reason + ")" : ""));
}

function setStopRelay(on, reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY;
  if (dev[path] === on) {
    return;
  }
  dev[path] = on;
  gLog("Реле глушения " + (on ? "ВКЛ" : "ВЫКЛ") + (reason ? " (" + reason + ")" : ""));
}

function stopStarter(reason) {
  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY;
  if (!st.starter_active && !dev[path]) {
    return;
  }
  dev[path] = false;
  st.starter_active = false;
  st.starter_from_autostart = false;
  clearTimer("starter_attempt");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  gLog("Стартер ВЫКЛ" + (reason ? " (" + reason + ")" : ""));
}

// ========= МОНИТОРИНГ VIN 12 В ================================

function updateVin() {
  if (typeof dev[CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL] === "undefined") {
    return;
  }
  var v = dev[CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL];
  var ok = v >= CFG.VIN_MIN;
  dev[CFG.GEN_VDEV + "/vin_12v_ok"] = ok;
}

defineRule("gen_vin_monitor", {
  whenChanged: CFG.VIN_DEVICE + "/" + CFG.VIN_CONTROL,
  then: function () {
    updateVin();
  }
});

// ========= МОНИТОРИНГ УРОВНЯ МАСЛА ============================

function updateOilLow() {
  var raw = dev[CFG.GPIO_DEVICE + "/" + CFG.OIL_INPUT];
  var low = !!raw; // замкнуто = авария
  dev[CFG.GEN_VDEV + "/oil_low"] = low;
  if (low) {
    gLog("Низкий уровень масла — блокировка запуска");
  }
}

defineRule("gen_oil_monitor", {
  whenChanged: CFG.GPIO_DEVICE + "/" + CFG.OIL_INPUT,
  then: function () {
    updateOilLow();
  }
});

// ========= МОНИТОРИНГ СЕТИ ====================================

function updateGridState(fromInit) {
  var l1 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1];
  var l2 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2];
  var l3 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3];

  if (typeof l1 === "undefined") { l1 = 0; }
  if (typeof l2 === "undefined") { l2 = 0; }
  if (typeof l3 === "undefined") { l3 = 0; }

  dev[CFG.GEN_VDEV + "/voltage_l1"] = l1;
  dev[CFG.GEN_VDEV + "/voltage_l2"] = l2;
  dev[CFG.GEN_VDEV + "/voltage_l3"] = l3;

  var ok =
    l1 >= CFG.GRID_V_MIN && l1 <= CFG.GRID_V_MAX &&
    l2 >= CFG.GRID_V_MIN && l2 <= CFG.GRID_V_MAX &&
    l3 >= CFG.GRID_V_MIN && l3 <= CFG.GRID_V_MAX;

  /* блок voltage_changed оставлен закомментированным, т.к. сенсор не используется
  var changed = false;
  if (!fromInit) {
    if (Math.abs(l1 - st.last_voltages[0]) >= 1 ||
        Math.abs(l2 - st.last_voltages[1]) >= 1 ||
        Math.abs(l3 - st.last_voltages[2]) >= 1) {
      changed = true;
    }
  }
  st.last_voltages = [l1, l2, l3];
  */

  dev[CFG.GEN_VDEV + "/grid_ok"] = ok;
  st.grid_ok = ok;

  return ok;
}

function handleGridLost() {
  var l1 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1];
  var l2 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2];
  var l3 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3];

  gLog("Напряжение посёлка вне нормы или отсутствует (L1=" + l1 +
       ", L2=" + l2 + ", L3=" + l3 + ")");
  dev[CFG.GEN_VDEV + "/status"] = "СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА";

  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" &&
      !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    startAutostart();
  } else {
    gLog("Автозапуск не выполняется (режим не AUTO или аварийный стоп)");
  }
}

function handleGridRestored() {
  var l1 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1];
  var l2 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2];
  var l3 = dev[CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3];

  gLog("Напряжение посёлка в норме (L1=" + l1 +
       ", L2=" + l2 + ", L3=" + l3 + ")");

  if (!dev[CFG.GEN_VDEV + "/house_on_gen"]) {
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    setK1(true, "сеть восстановилась, дом был на посёлке");
    return;
  }

  if (dev[CFG.GEN_VDEV + "/mode"] === "AUTO" &&
      !dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    scheduleReturnToGrid();
  } else {
    gLog("Возврат на посёлок не запущен (режим не AUTO или аварийный стоп)");
  }
}


defineRule("gen_grid_monitor", {
  whenChanged: [
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L1,
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L2,
    CFG.GRID_METER_DEVICE + "/" + CFG.GRID_V_L3
  ],
  then: function () {
    var prev = st.grid_ok;
    var ok = updateGridState(false);

    // Если после обновления всё в норме
    if (ok) {
      // если до этого считали, что «плохо» — фиксируем возврат
      if (!prev) {
        clearTimer("grid_fail_debounce");
        gLog("Сеть вернулась в норму (debounce сброшен)");
        handleGridRestored();
      } else {
        // было хорошо и осталось хорошо — просто сбрасываем возможный таймер
        clearTimer("grid_fail_debounce");
      }
      return;
    }

    // Здесь ok === false (напряжение сейчас вне диапазона)

    // Если уже раньше считали, что сети нет — второй раз ничего не делаем
    if (!prev) {
      return;
    }

    // Это первый переход из «нормы» в «плохо» — запускаем debounce
    clearTimer("grid_fail_debounce");
    gLog("Обнаружено отклонение напряжения, возможно пропадание сети — " +
         "ждём " + (CFG.GRID_FAIL_DEBOUNCE_MS / 1000) + " с для подтверждения");

    st.timers.grid_fail_debounce = setTimeout(function () {
      var ok2 = updateGridState(false);
      if (!ok2) {
        gLog("Подтверждено: напряжение вне нормы дольше " +
             (CFG.GRID_FAIL_DEBOUNCE_MS / 1000) + " с — считаем, что сети нет");
        handleGridLost();
      } else {
        gLog("Ложное срабатывание: к моменту проверки напряжение вернулось в норму");
      }
    }, CFG.GRID_FAIL_DEBOUNCE_MS);
  }
});


// Реальное состояние К1 -> manual_k1_grid + k1_grid_state
defineRule("sync_manual_k1_from_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1,
  then: function (newValue) {
    var v = !!newValue;
    dev[CFG.GEN_VDEV + "/manual_k1_grid"] = v;
    dev[CFG.GEN_VDEV + "/k1_grid_state"] = v;
    gLog("Синхронизация от реального К1: " + (v ? "ВКЛ" : "ВЫКЛ"));
  }
});

// Реальное состояние К4 -> manual_k4_gen + k4_gen_state
defineRule("sync_manual_k4_from_real", {
  whenChanged: CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4,
  then: function (newValue) {
    var v = !!newValue;
    dev[CFG.GEN_VDEV + "/manual_k4_gen"] = v;
    dev[CFG.GEN_VDEV + "/k4_gen_state"] = v;
    gLog("Синхронизация от реального К4: " + (v ? "ВКЛ" : "ВЫКЛ"));
  }
});


// ========= МОНИТОРИНГ СИГНАЛА ОТ ГЕНЕРАТОРА ===================

defineRule("gen_voltage_input_monitor", {
  whenChanged: CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT,
  then: function (newValue) {
    var running = !!newValue;

    if (running && !st.generator_running) {
      st.generator_running = true;
      gLog("Обнаружено напряжение от генератора");
      if (st.starter_active) {
        gLog("Генератор запустился, отпускаем стартер через " +
             (CFG.STARTER_RELEASE_MS / 1000) + " c");
        clearTimer("starter_release");
        st.timers.starter_release = setTimeout(function () {
          stopStarter("генератор завёлся");
        }, CFG.STARTER_RELEASE_MS);
        // закрываем заслонку спустя STARTER_RELEASE_MS + CHOKE_CLOSE_MS
        clearTimer("choke_close");
        st.timers.choke_close = setTimeout(function () {
          setChoke(false, "закрываем заслонку после запуска");
        }, CFG.STARTER_RELEASE_MS + CFG.CHOKE_CLOSE_MS);
      }
      // прогрев и перевод дома на генератор — только в автозапуске
      if (st.autostart_in_progress) {
        startWarmupAndTransfer();
      }
    } else if (!running && st.generator_running) {
      st.generator_running = false;
      gLog("Сигнал генератора пропал");
      // Можно закрыть заслонку, если генератор остановился
      setChoke(false, "генератор остановлен");
    }
  }
});

// ========= СТАРТЕР: ОБЩАЯ ЛОГИКА И ЗАЩИТЫ =====================

function startStarter(withRetry, fromAutostart) {
  if (st.starter_active) {
    gLog("Попытка включить стартер, но он уже активен — игнор");
    return;
  }
  if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    gLog("Стартер не включаем: аварийный стоп активен");
    return;
  }
  if (dev[CFG.GEN_VDEV + "/oil_low"]) {
    gLog("Стартер не включаем: низкий уровень масла");
    return;
  }
  if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT]) {
    gLog("Стартер не включаем: генератор уже работает");
    return;
  }

  st.starter_active = true;
  st.starter_from_autostart = !!fromAutostart;
  st.starter_started_at = Date.now();

  var path = CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY;
  dev[path] = true;
  gLog("Стартер ВКЛ");

  clearTimer("starter_watchdog");
  st.timers.starter_watchdog = setTimeout(function () {
    if (st.starter_active) {
      stopStarter("таймаут " + (CFG.STARTER_MAX_MS / 1000) + " c");
      if (withRetry && st.autostart_in_progress) {
        handleStartFail();
      }
    }
  }, CFG.STARTER_MAX_MS);

  clearTimer("starter_attempt");
  st.timers.starter_attempt = setTimeout(function () {
    if (!st.starter_active) {
      return;
    }
    if (dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT]) {
      return; // генератор завёлся, отпускание обработает другое правило
    }
    stopStarter("не завёлся за " + (CFG.CRANK_TIME_MS / 1000) + " c");
    if (withRetry && st.autostart_in_progress) {
      handleStartFail();
    }
  }, CFG.CRANK_TIME_MS);
}

function handleStartFail() {
  if (!st.autostart_in_progress) {
    return;
  }
  if (st.attempts >= CFG.MAX_ATTEMPTS) {
    gLog("Генератор не запущен после " + CFG.MAX_ATTEMPTS + " попыток");
    dev[CFG.GEN_VDEV + "/status"] = "Ошибка запуска";
    st.autostart_in_progress = false;
    setChoke(false, "запуск не удался");
    return;
  }
  gLog("Генератор не запустился, пауза " +
       (CFG.REST_AFTER_FAIL_MS / 1000) + " c перед следующей попыткой");
  clearTimer("starter_attempt");
  clearTimer("starter_watchdog");
  clearTimer("starter_release");
  st.timers.starter_attempt = setTimeout(function () {
    if (!st.autostart_in_progress || dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      gLog("Повторный запуск отменён (остановлен или аварийный стоп)");
      return;
    }
    st.attempts += 1;
    gLog("Попытка запуска #" + st.attempts);
    setChoke(true, "очередная попытка");
    startStarter(true, true);
  }, CFG.REST_AFTER_FAIL_MS);
}

// защита: стартер и стоп-реле не могут быть одновременно активны
defineRule("gen_safety_starter_stop", {
  whenChanged: [
    CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY,
    CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY
  ],
  then: function () {
    var starterOn = dev[CFG.GEN_RELAY_DEVICE + "/" + CFG.STARTER_RELAY];
    var stopOn    = dev[CFG.GEN_RELAY_DEVICE + "/" + CFG.STOP_RELAY];
    if (starterOn && stopOn) {
      gLog("Реле глушения включено — принудительно отключаем стартер");
      stopStarter("конфликт со стоп-реле");
    }
  }
});

// ========= АВТОЗАПУСК ГЕНЕРАТОРА ==============================

function startAutostart() {
  if (st.autostart_in_progress) {
    gLog("Автозапуск уже выполняется");
    return;
  }
  if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
    gLog("Автозапуск заблокирован аварийным стопом");
    return;
  }
  if (dev[CFG.GEN_VDEV + "/oil_low"]) {
    dev[CFG.GEN_VDEV + "/status"] = "Ошибка: низкий уровень масла";
    gLog("Автозапуск невозможен: низкий уровень масла");
    return;
  }

  st.autostart_in_progress = true;
  st.attempts = 1;

  dev[CFG.GEN_VDEV + "/status"] = "СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА";
  gLog("СЕТИ НЕТ — ЗАПУСК ГЕНЕРАТОРА (попытка #1)");

  // на всякий случай отключаем К1
  setK1(false, "автозапуск");
  // открываем заслонку
  setChoke(true, "автозапуск");
  // включаем стартер
  startStarter(true, true);
}

function startWarmupAndTransfer() {
  clearTimer("warmup");
  gLog("Прогрев генератора " + (CFG.WARMUP_MS / 1000) + " c");
  dev[CFG.GEN_VDEV + "/status"] = "Генератор запущен, прогрев";

  st.timers.warmup = setTimeout(function () {
    if (!st.generator_running) {
      gLog("Прогрев отменён: сигнал генератора пропал");
      return;
    }
    // включаем К4 и оставляем К1 выключенным
    setK4(true, "после прогрева, питание дома от генератора");
    setK1(false, "дом переходит на генератор");
    dev[CFG.GEN_VDEV + "/house_on_gen"] = true;
    dev[CFG.GEN_VDEV + "/status"] = "Дом на генераторе";
    gLog("Дом переведён на питание от генератора");
  }, CFG.WARMUP_MS);
}

// ========= ВОЗВРАТ НА СЕТЬ ====================================

function scheduleReturnToGrid() {
  if (!dev[CFG.GEN_VDEV + "/house_on_gen"]) {
    gLog("Запрошен возврат, но дом уже на посёлке");
    return;
  }
  if (st.return_in_progress) {
    gLog("Возврат на посёлок уже выполняется");
    return;
  }

  st.return_in_progress = true;
  clearTimer("return_wait");

  dev[CFG.GEN_VDEV + "/status"] =
    "Возврат на посёлок (" + (CFG.RETURN_WAIT_MS / 1000) + " c)";
  gLog("Начинаем процедуру возврата на посёлок, ожидание " +
       (CFG.RETURN_WAIT_MS / 1000) + " c с питанием от генератора");

  st.timers.return_wait = setTimeout(function () {
    var ok = updateGridState(false);
    if (!ok) {
      gLog("Возврат отменён — напряжение снова вне нормы");
      dev[CFG.GEN_VDEV + "/status"] = "Дом на генераторе (сеть нестабильна)";
      st.return_in_progress = false;
      return;
    }
    performReturnSwitch();
  }, CFG.RETURN_WAIT_MS);
}

function performReturnSwitch() {
  gLog("Сеть стабильна, переключаем дом на посёлок");

  // 1. Включаем К1 (посёлок)
  setK1(true, "возврат на посёлок");
  dev[CFG.GEN_VDEV + "/house_on_gen"] = false;

  // 2. Глушим генератор импульсом STOP_PULSE_MS
  clearTimer("stop_pulse");
  setStopRelay(true, "возврат на посёлок");
  st.timers.stop_pulse = setTimeout(function () {
    setStopRelay(false, "завершение глушения при возврате");
  }, CFG.STOP_PULSE_MS);

  // 3. Через K4_OFF_AFTER_RETURN_MS выключаем К4
  clearTimer("k4_off_delay");
  st.timers.k4_off_delay = setTimeout(function () {
    setK4(false, "завершение возврата на посёлок");
    dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    st.return_in_progress = false;
  }, CFG.K4_OFF_AFTER_RETURN_MS);
}

// ========= РЕЖИМЫ (AUTO / MANUAL) И РУЧНОЙ РЕЖИМ ==============

defineRule("gen_mode_changed", {
  whenChanged: CFG.GEN_VDEV + "/mode",
  then: function (newValue) {
    if (newValue !== "AUTO" && newValue !== "MANUAL") {
      // на всякий случай нормализуем
      dev[CFG.GEN_VDEV + "/mode"] = "AUTO";
      newValue = "AUTO";
    }
    // синхронизируем тумблер mode_auto
    dev[CFG.GEN_VDEV + "/mode_auto"] = (newValue === "AUTO");
    gLog("Режим работы: " + newValue);
  }
});

defineRule("gen_mode_auto_switch", {
  whenChanged: CFG.GEN_VDEV + "/mode_auto",
  then: function (newValue) {
    dev[CFG.GEN_VDEV + "/mode"] = newValue ? "AUTO" : "MANUAL";
  }
});

// ручное управление К1
defineRule("gen_manual_k1", {
  whenChanged: CFG.GEN_VDEV + "/manual_k1_grid",
  then: function (newValue) {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("manual_k1_grid изменён не в MANUAL, игнорирую");
      dev[CFG.GEN_VDEV + "/manual_k1_grid"] =
        dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1];
      return;
    }
    setK1(!!newValue, "ручное управление");
  }
});

// ручное управление К4
defineRule("gen_manual_k4", {
  whenChanged: CFG.GEN_VDEV + "/manual_k4_gen",
  then: function (newValue) {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("manual_k4_gen изменён не в MANUAL, игнорирую");
      dev[CFG.GEN_VDEV + "/manual_k4_gen"] =
        dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4];
      return;
    }
    setK4(!!newValue, "ручное управление");
  }
});

// ручной запуск — одна попытка, без логики контакторов
defineRule("gen_manual_start", {
  whenChanged: CFG.GEN_VDEV + "/manual_start",
  then: function () {
    if (dev[CFG.GEN_VDEV + "/mode"] !== "MANUAL") {
      gLog("manual_start нажата не в MANUAL, игнорирую");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/emergency_stop"]) {
      gLog("manual_start заблокирован аварийным стопом");
      return;
    }
    if (dev[CFG.GEN_VDEV + "/oil_low"]) {
      gLog("manual_start невозможен: низкий уровень масла");
      return;
    }

    gLog("Ручной запуск: одна попытка");
    setChoke(true, "ручной запуск");
    startStarter(false, false);

    // закрываем заслонку через CRANK + CHOKE_CLOSE, если генератор так и не завёлся
    clearTimer("choke_close_manual");
    st.timers.choke_close_manual = setTimeout(function () {
      if (!dev[CFG.GPIO_DEVICE + "/" + CFG.GEN_VOLTAGE_INPUT] &&
          !st.starter_active) {
        setChoke(false, "закрываем заслонку после ручной попытки");
      }
    }, CFG.CRANK_TIME_MS + CFG.CHOKE_CLOSE_MS);
  }
});

// ========= АВАРИЙНЫЙ СТОП =====================================

defineRule("gen_emergency_stop", {
  whenChanged: CFG.GEN_VDEV + "/emergency_stop",
  then: function (newValue) {
    if (newValue) {
      gLog("Установлен emergency_stop — все процедуры запуска/возврата будут прерваны");
      st.autostart_in_progress = false;
      st.return_in_progress = false;
      clearAllTimers();
      stopStarter("аварийный стоп");
      setChoke(false, "аварийный стоп");
      // глушим генератор
      setStopRelay(true, "аварийный стоп");
      clearTimer("stop_pulse");
      st.timers.stop_pulse = setTimeout(function () {
        setStopRelay(false, "отпускание стоп-реле после аварии");
      }, CFG.STOP_PULSE_MS);
      dev[CFG.GEN_VDEV + "/status"] = "Аварийный стоп";
    } else {
      gLog("Сброшен emergency_stop");
    }
  }
});

// ========= ОТСЛЕЖИВАНИЕ СОСТОЯНИЯ К1/К4 =======================

defineRule("gen_track_contactors", {
  whenChanged: [
    CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1,
    CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4
  ],
  then: function () {
    var k1 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1];
    var k4 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4];

    dev[CFG.GEN_VDEV + "/k1_grid_state"] = k1;
    dev[CFG.GEN_VDEV + "/k4_gen_state"] = k4;

    if (k4 && !k1) {
      dev[CFG.GEN_VDEV + "/house_on_gen"] = true;
    } else if (k1 && !k4) {
      dev[CFG.GEN_VDEV + "/house_on_gen"] = false;
    }
  }
});

// ========= ИНИЦИАЛИЗАЦИЯ ПРИ ЗАПУСКЕ СКРИПТА ==================

defineRule("gen_init", {
  asSoonAs: function () {
    return true;
  },
  then: function () {
    gLog("Инициализация логики генератора");

    updateVin();
    updateOilLow();
    updateGridState(true);

    // Считываем текущее состояние контакторов
    var k1 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GRID_K1];
    var k4 = !!dev[CFG.CONTACTOR_DEVICE + "/" + CFG.GEN_K4];
    dev[CFG.GEN_VDEV + "/k1_grid_state"] = k1;
    dev[CFG.GEN_VDEV + "/k4_gen_state"] = k4;

    // Базовое правило: при наличии нормальной сети дом должен быть на посёлке
    if (st.grid_ok) {
      setK1(true, "инициализация, сеть в норме");
      setK4(false, "инициализация, сеть в норме");
      dev[CFG.GEN_VDEV + "/house_on_gen"] = false;
      dev[CFG.GEN_VDEV + "/status"] = "Дом на посёлке";
    } else {
      dev[CFG.GEN_VDEV + "/status"] =
        "Сеть вне нормы при старте, дом на текущем источнике";
    }

    gLog("Инициализация завершена, режим: " + dev[CFG.GEN_VDEV + "/mode"]);
  }
});
