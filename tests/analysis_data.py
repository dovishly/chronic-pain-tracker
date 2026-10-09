"""The known data in fixtures/analysis.json, with names for the ids the tests look up.

e2e_test.py checks the app's analysis export of this data; schema_test.py uses it as a user's rows.
Times in the comments are local (America/New_York); the file stores them in UTC.
"""
import json, os

FIXTURE = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'analysis.json')))
TIMEZONE = FIXTURE['timezone']


def entry(n):
    return f'00000000-0000-4000-9000-0000000000{n:02d}'


def checkin(n):
    return f'00000000-0000-4000-a000-0000000000{n:02d}'


# Episodes. An episode's id is the id of the entry that started it.
HEADACHE_SEP1 = entry(8)        # Sep 1 10:00–12:00; levels Moderate (10:30) then Severe (11:00); note "woke with it"
TIRED_OVERNIGHT = entry(12)     # Sep 1 22:00 – Sep 2 01:30
HEADACHE_RESTARTED = entry(18)  # Sep 2 15:00, cut short when Headache was started again at 16:00
HEADACHE_SEP2 = entry(19)       # Sep 2 16:00–16:30
TIRED_ONGOING = entry(23)       # Sep 4 07:00, never ended

# Entries
JOURNAL_ANSWER = entry(5)           # "Slept ok", Sep 1 morning check-in
MOOD_EVENING = entry(6)             # Bad (2), Sep 1 20:00 (Sep 2 00:00 in UTC)
HEADACHE_MODERATE = entry(9)        # level 2 during HEADACHE_SEP1
TIRED_OVERNIGHT_END = entry(13)
HEADACHE_SEP2_END = entry(20)
DELETED_COFFEE = entry(21)          # Sep 2 10:00, deleted
COFFEE_DURING_HEADACHE = entry(24)  # Sep 1 11:30
MOOD_WHILE_TIRED = entry(25)        # Okay (3), Sep 4 09:00, during TIRED_ONGOING

# Check-ins
MORNING_SEP1 = checkin(1)  # 09:00: Mood Good, Water 3, Exercise and Work, Journal "Slept ok"
EVENING_SEP1 = checkin(2)  # 20:00: Mood Bad, Water 5
MORNING_SEP2 = checkin(3)  # 09:00: Mood Great with a note, Friends
MORNING_SEP4 = checkin(4)  # 09:00: Mood Okay, while Tired
