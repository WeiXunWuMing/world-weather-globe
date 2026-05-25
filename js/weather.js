// 气象监测引擎 // 对接 Open-Meteo 实时 API、防抖查询控制以及离线气候物理模拟发生器。

(function() {
  const cache = {};
  const CACHE_PREFIX = "weather_globe_cache_";

  // WMO 国际气象组织天气标准代码解析表（中文本地化）
  const WMO_CODES = {
    0: { desc: "晴朗天空", icon: "clear" },
    1: { desc: "晴间多云", icon: "cloudy-light" },
    2: { desc: "部分多云", icon: "cloudy" },
    3: { desc: "阴天笼罩", icon: "cloudy-dense" },
    45: { desc: "雾气弥漫", icon: "fog" },
    48: { desc: "积冰雾凇", icon: "fog" },
    51: { desc: "微量细雨", icon: "rain-light" },
    53: { desc: "小毛毛雨", icon: "rain-light" },
    55: { desc: "密集毛毛雨", icon: "rain-light" },
    56: { desc: "轻微冻毛毛雨", icon: "sleet" },
    57: { desc: "强冻毛毛雨", icon: "sleet" },
    61: { desc: "轻微阵雨", icon: "rain" },
    63: { desc: "中度降雨", icon: "rain" },
    65: { desc: "暴雨倾盆", icon: "rain-dense" },
    66: { desc: "轻微冻雨", icon: "sleet" },
    67: { desc: "重度强冻雨", icon: "sleet" },
    71: { desc: "轻微降雪", icon: "snow-light" },
    73: { desc: "中度积雪", icon: "snow" },
    75: { desc: "暴雪席卷", icon: "snow-dense" },
    77: { desc: "冰针米雪", icon: "snow" },
    80: { desc: "轻微弱阵雨", icon: "rain" },
    81: { desc: "中度阵雨", icon: "rain" },
    82: { desc: "剧烈短时强降雨", icon: "rain-dense" },
    85: { desc: "轻微弱阵雪", icon: "snow" },
    86: { desc: "重度强阵雪", icon: "snow-dense" },
    95: { desc: "雷暴强对流", icon: "storm" },
    96: { desc: "雷暴伴有冰雹", icon: "storm" },
    99: { desc: "强雷暴极端天气", icon: "storm-dense" }
  };

  /**
   * 将高精度经纬度坐标约化为 1 位小数的缓存网格键（相当于 ~11km 范围网格）
   */
  function makeCacheKey(lat, lon) {
    return `${lat.toFixed(1)},${lon.toFixed(1)}`;
  }

  /**
   * 离线物理气候发生器：当API超时或断网时，根据地理学规律计算出逼真的气象指标
   */
  function generateMockWeather(lat, lon, locationName = "大洋网格") {
    // 1. 纬度热量递减算法：赤道炎热，两极严寒
    const latAbs = Math.abs(lat);
    let baseTemp = 28 - (latAbs * 0.7); // 赤道基准 28°C，南北极基准 -35°C
    
    // 结合本地系统时间追加日温差昼夜摆动
    const hour = new Date().getHours();
    const timeDiurnal = Math.sin((hour - 6) / 24 * Math.PI * 2); // 早上6点最低温，下午6点最高温
    baseTemp += timeDiurnal * 4.5;

    // 2. 根据纬度带与噪声因子生成合理的气象状态代码
    let wCode = 0;
    if (latAbs > 60) {
      // 寒带/极地：高概率积雪
      wCode = Math.random() > 0.4 ? 73 : 3; 
    } else if (latAbs < 15) {
      // 热带赤道：高概率强对流雷雨
      wCode = Math.random() > 0.5 ? 95 : (Math.random() > 0.5 ? 63 : 2);
    } else {
      // 温带：四季分明，天气均衡
      const rand = Math.random();
      if (rand < 0.3) wCode = 0; // 晴朗
      else if (rand < 0.6) wCode = 2; // 多云
      else if (rand < 0.8) wCode = 63; // 降雨
      else wCode = 1; // 晴间多云
    }

    const condition = WMO_CODES[wCode] || { desc: "晴朗天空", icon: "clear" };
    const humidity = Math.floor(60 + Math.random() * 35); // 60% - 95%
    const windSpeed = Math.round(5 + Math.random() * 25); // 5 - 30 km/h
    const windDirection = Math.floor(Math.random() * 360);
    const cloudCover = wCode === 0 ? 0 : (wCode === 2 ? 50 : 100);

    // 编制未来 5 小时的预测曲线
    const forecast = [];
    const currentHour = new Date().getHours();
    for (let i = 1; i <= 5; i++) {
      const fHour = (currentHour + i) % 24;
      const diurnalF = Math.sin((fHour - 6) / 24 * Math.PI * 2);
      const fTemp = roundVal(28 - (latAbs * 0.7) + (diurnalF * 4.5) + (Math.random() - 0.5));
      forecast.push({
        time: `${fHour.toString().padStart(2, '0')}:00`,
        temp: fTemp,
        weatherCode: wCode
      });
    }

    return {
      isMock: true,
      current: {
        temp: roundVal(baseTemp),
        desc: condition.desc,
        icon: condition.icon,
        humidity: humidity,
        windSpeed: windSpeed,
        windDir: windDirection,
        clouds: cloudCover
      },
      forecast: forecast
    };
  }

  function roundVal(val) {
    return Math.round(val * 10) / 10;
  }

  /**
   * 拉取指定坐标的气象监测数据
   */
  async function getWeather(lat, lon, locationName = "") {
    const key = makeCacheKey(lat, lon);

    // 1. 尝试从内存读取
    if (cache[key]) {
      return cache[key];
    }

    // 2. 尝试从浏览器 SessionStorage 中提取
    try {
      const stored = sessionStorage.getItem(CACHE_PREFIX + key);
      if (stored) {
        const parsed = JSON.parse(stored);
        cache[key] = parsed;
        return parsed;
      }
    } catch (e) {
      // 浏览器权限受限或写满，静默忽略
    }

    // 3. 执行 API 线上查询
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 6000); // 6秒超时硬中断
      
      const apiURL = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,weather_code&forecast_days=1`;
      
      const response = await fetch(apiURL, { signal: controller.signal });
      clearTimeout(id);

      if (!response.ok) {
        throw new Error(`API 端口返回了错误状态: ${response.status}`);
      }

      const data = await response.json();
      
      const currentCode = data.current.weather_code;
      const cond = WMO_CODES[currentCode] || { desc: "实况监测站数据", icon: "clear" };
      
      // 分析提取未来 5 小时的逐小时气象走势
      const forecast = [];
      const currentHour = new Date().getHours();
      
      if (data.hourly && data.hourly.time && data.hourly.temperature_2m) {
        const startIdx = Math.max(0, currentHour + 1);
        for (let i = 0; i < 5; i++) {
          const idx = (startIdx + i) % 24;
          const timeStr = data.hourly.time[idx];
          const hourLabel = timeStr ? timeStr.split('T')[1] : `${((currentHour + i + 1) % 24).toString().padStart(2, '0')}:00`;
          
          forecast.push({
            time: hourLabel,
            temp: roundVal(data.hourly.temperature_2m[idx]),
            weatherCode: data.hourly.weather_code ? data.hourly.weather_code[idx] : currentCode
          });
        }
      }

      const result = {
        isMock: false,
        current: {
          temp: roundVal(data.current.temperature_2m),
          desc: cond.desc,
          icon: cond.icon,
          humidity: Math.round(data.current.relative_humidity_2m),
          windSpeed: roundVal(data.current.wind_speed_10m),
          windDir: Math.round(data.current.wind_direction_10m),
          clouds: Math.round(data.current.cloud_cover)
        },
        forecast: forecast
      };

      // 写入两层缓存中
      cache[key] = result;
      try {
        sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(result));
      } catch (e) {}

      return result;

    } catch (err) {
      console.warn(`无法从 Open-Meteo 获取 [${lat}, ${lon}] 的天气: ${err.message}. 自动加载物理气候模型。`);
      
      const mockResult = generateMockWeather(lat, lon, locationName);
      
      // 仅在运行内存中缓存此仿真数据（不存Session，确保重新联网后能及时请求真实API）
      cache[key] = mockResult;
      return mockResult;
    }
  }

  // 挂载至全局气象命名空间
  window.WEATHER_SYSTEM = {
    getWeather: getWeather,
    getWMOCodeDetails: function(code) {
      return WMO_CODES[code] || { desc: "未定义气象", icon: "clear" };
    }
  };
})();
