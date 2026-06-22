import { getCallLogs, getCallSessions } from "../repositories/analyticsRepository.js";

export const getAnalytics = async (req, res) => {
  try {
    const [logs, sessions] = await Promise.all([
      getCallLogs(),
      getCallSessions(),
    ]);

    const totalCalls = sessions.length;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCalls = sessions.filter(s => new Date(s.startedAt || s.createdAt) >= todayStart).length;

    const conversions = logs.filter((l) => String(l.intent || "").toLowerCase() === "interested").length;
    const conversionRate = totalCalls > 0
      ? parseFloat(((conversions / totalCalls) * 100).toFixed(1))
      : 0;

    const liveStatuses = new Set(["initiated", "ringing", "in-progress", "answered", "active"]);
    const liveSessions = sessions.filter((session) =>
      liveStatuses.has(String(session.status || "").toLowerCase())
    );

    const completedDurations = sessions
      .map((s) => Number(s.durationSec || 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const avgDurationSec = completedDurations.length
      ? Math.round(completedDurations.reduce((sum, n) => sum + n, 0) / completedDurations.length)
      : 0;

    const sentiment = {
      positive: logs.filter((l) => l.sentiment === "Positive").length,
      neutral:  logs.filter((l) => l.sentiment === "Neutral").length,
      negative: logs.filter((l) => l.sentiment === "Negative").length,
    };

    const recentMessages = logs
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, 10);

    res.json({
      totalCalls,
      todayCalls,
      conversions,
      conversionRate,
      sentiment,
      liveCount: liveSessions.length,
      hasLiveSession: liveSessions.length > 0,
      currentLiveSession: liveSessions[0] || null,
      avgDurationSec,
      recentMessages,
    });
  } catch (err) {
    console.error("getAnalytics error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
