// The program a fresh server starts with: a small example. Replace it from the admin page (Program) or with PUT /program.
export const DEFAULT_PROGRAM = {
 "title": "Example event",
 "days": [
  {
   "key": "day1",
   "label": "Day 1",
   "date": "2026-01-10"
  },
  {
   "key": "day2",
   "label": "Day 2",
   "date": "2026-01-11"
  }
 ],
 "goal": {
  "total": 60,
  "dayKey": "day2",
  "dayMin": 30
 },
 "events": [
  {
   "id": "table-tennis",
   "day": "day1",
   "title": "Table tennis",
   "room": "Hall",
   "from": "10:00",
   "to": "12:00",
   "model": "rate",
   "rate": 8,
   "block": 12,
   "cap": 24,
   "rule": "8 points per 12 minutes, up to 24 points."
  },
  {
   "id": "opening",
   "day": "day1",
   "title": "Opening show",
   "room": "Main hall",
   "from": "15:00",
   "to": "16:00",
   "model": "flat",
   "cap": 10,
   "rule": "10 points for everyone who stays until the end."
  },
  {
   "id": "quiz-room",
   "day": "day2",
   "title": "Quiz room",
   "room": "Room 12",
   "from": "09:00",
   "to": "13:00",
   "model": "tasks",
   "items": [
    {
     "name": "Music quiz",
     "pts": 5,
     "min": 10
    },
    {
     "name": "Picture quiz",
     "pts": 5,
     "min": 10
    },
    {
     "name": "Team round",
     "pts": 8,
     "min": 15
    }
   ],
   "rule": "Three quizzes, each with its own points."
  },
  {
   "id": "chess",
   "day": "day2",
   "title": "Chess corner",
   "room": "Library",
   "from": "09:00",
   "to": "13:00",
   "model": "rate",
   "rate": 6,
   "block": 10,
   "maxMin": 90,
   "rule": "6 points per 10 minutes, for at most 90 minutes.",
   "bonus": "+2 points for each match won"
  },
  {
   "id": "workshop",
   "day": "day2",
   "title": "Robot workshop",
   "room": "Lab",
   "from": "10:00",
   "to": "11:30",
   "model": "tasks",
   "items": [
    {
     "name": "Build",
     "pts": 12,
     "min": 30
    },
    {
     "name": "Race",
     "pts": 6,
     "min": 15
    }
   ],
   "rule": "Build a robot, then race it.",
   "bring": "Bring a pen"
  }
 ]
} as const;
