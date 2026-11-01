import type { Meeting } from "./models";

export const MEETING_DURATION_MS = 4 * 60 * 60 * 1000;

export function meetingStatus(meeting: Meeting, now: number): "upcoming" | "ongoing" | "finished" {
  const start = Date.parse(meeting.startsAt);
  return now >= start + MEETING_DURATION_MS ? "finished" : now >= start ? "ongoing" : "upcoming";
}

export function upcomingMeetings(
  meetings: Meeting[],
  now: number,
): Meeting[] {
  return meetings
    .filter((meeting) => meetingStatus(meeting, now) !== "finished")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))
    .slice(0, 2);
}
