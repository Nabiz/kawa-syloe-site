import type { Meeting } from "./models";

export function upcomingMeetings(
  meetings: Meeting[],
  now: number,
): Meeting[] {
  return meetings
    .filter((meeting) => Date.parse(meeting.startsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, 2);
}
