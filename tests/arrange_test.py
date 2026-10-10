"""Arranging Today, each test on a new phone: moving trackers with the arrows and by dragging, and adding one
from a section's "+ Add"."""
from playwright.sync_api import expect
from harness import Phone, tracker_names


def today_layout(phone):
    """Today's headings, each with its rows of trackers' names, as they show."""
    return phone.page.evaluate('''() => [...document.querySelectorAll('#view-today > section')]
      .filter(section => section.querySelector('.today-grid'))
      .map(section => {
        const rows = [];
        for (const tile of section.querySelectorAll('.today-grid > :is(.episode-card, .moment-button, .arrange-tile)')) {
          const name = tile.querySelector('.episode-name, .moment-name, .arrange-name').textContent;
          if (tile.classList.contains('starts-row')) rows.push([name]);
          else rows.at(-1).push(name);
        }
        return [section.querySelector('h2').textContent, rows];
      })''')


def drag_onto(phone, name, target):
    """Drags the tile with this name, while arranging, to the middle of the target."""
    tile = phone.locator('[data-arrange]', has_text=name).bounding_box()
    box = target.bounding_box()
    start = (tile['x'] + 30, tile['y'] + 20)
    end = (box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    phone.page.mouse.move(*start)
    phone.page.mouse.down()
    for step in range(1, 21):
        phone.page.mouse.move(start[0] + (end[0] - start[0]) * step / 20, start[1] + (end[1] - start[1]) * step / 20)
    phone.page.wait_for_timeout(100)  # held there a moment, as a hand would, so it's seen to be over the target
    phone.page.mouse.up()
    phone.page.wait_for_timeout(300)  # while the tile settles into place, the next tap or drag isn't taken


def test_arrange_today_with_the_arrows(browser, supabase):
    phone = Phone(browser, supabase)
    assert today_layout(phone) == [['Symptoms', [['Pain'], ['Fatigue']]], ['Moments', [['Medication']]]]
    phone.page.click('#arrange-today')
    phone.locator('button[aria-label="Move Moments up"]').click()
    expect(phone.locator('#view-today h2').first).to_have_text('Moments')

    medication = phone.locator('[data-arrange]', has_text='Medication')
    medication.click()
    expect(medication).to_have_attribute('aria-pressed', 'true')
    later, earlier, new_row = (phone.locator(f'#arrange-{button}') for button in ('later', 'earlier', 'new-row'))

    def moves_to(layout):
        phone.wait_for(lambda: today_layout(phone) == layout)
        assert today_layout(phone) == layout

    later.click()  # into the next heading, on a row of its own
    moves_to([['Symptoms', [['Medication'], ['Pain'], ['Fatigue']]]])
    medication.press('ArrowRight')  # the arrow keys move a picked tile too; onto a tile, they trade places
    moves_to([['Symptoms', [['Pain'], ['Medication'], ['Fatigue']]]])
    later.click()
    moves_to([['Symptoms', [['Pain'], ['Fatigue'], ['Medication']]]])
    expect(later).to_be_disabled()  # last of all
    earlier.click()  # into the empty space beside Fatigue
    moves_to([['Symptoms', [['Pain'], ['Fatigue', 'Medication']]]])
    fatigue = phone.locator('[data-arrange]', has_text='Fatigue').bounding_box()
    assert medication.bounding_box()['y'] == fatigue['y']
    new_row.click()
    moves_to([['Symptoms', [['Pain'], ['Fatigue'], ['Medication']]]])
    expect(new_row).to_be_disabled()  # on its own already
    phone.page.click('#arrange-done')

    assert today_layout(phone) == [['Symptoms', [['Pain'], ['Fatigue'], ['Medication']]]]
    fatigue = phone.locator('.episode-card', has_text='Fatigue').bounding_box()
    medication = phone.locator('.moment-button', has_text='Medication').bounding_box()
    assert medication['y'] > fatigue['y'] and medication['x'] == fatigue['x']  # a row of its own, with room beside it

    phone.open()  # saved
    assert today_layout(phone) == [['Symptoms', [['Pain'], ['Fatigue'], ['Medication']]]]
    phone.go_to('Settings')
    symptoms = phone.locator('.tracker-list-group', has_text='Symptoms').locator('xpath=following-sibling::ul[1]')
    expect(symptoms).to_contain_text('Medication')
    names = tracker_names(phone)  # the check-in questions kept their order
    assert [n for n in names if n in ('Mood', 'Sleep', 'Water', 'Activities', 'Notes')] == ['Mood', 'Sleep', 'Water', 'Activities', 'Notes']


def test_arrange_today_by_dragging(browser, supabase):
    phone = Phone(browser, supabase)
    phone.page.click('#arrange-today')
    symptoms = phone.locator('#view-today > section', has=phone.locator('h2', has_text='Symptoms'))

    drag_onto(phone, 'Medication', symptoms.locator('.arrange-space'))  # the empty space beside Fatigue
    assert today_layout(phone) == [['Symptoms', [['Pain'], ['Fatigue', 'Medication']]]]
    drag_onto(phone, 'Medication', symptoms.locator('.arrange-gap').last)  # below the last row: a new one
    assert today_layout(phone) == [['Symptoms', [['Pain'], ['Fatigue'], ['Medication']]]]
    drag_onto(phone, 'Fatigue', phone.locator('[data-arrange]', has_text='Pain'))  # onto a tile: they trade places
    assert today_layout(phone) == [['Symptoms', [['Fatigue'], ['Pain'], ['Medication']]]]

    phone.page.click('#arrange-done')
    assert today_layout(phone) == [['Symptoms', [['Fatigue'], ['Pain'], ['Medication']]]]


def test_add_from_a_section_and_come_back(browser, supabase):
    phone = Phone(browser, supabase)
    expect(phone.locator('[aria-label="Add to Moments"]')).to_have_count(0)  # only while arranging
    phone.page.click('#arrange-today')
    add_moment = phone.locator('[aria-label="Add to Moments"]')
    add_moment.click()
    expect(phone.locator('h1')).to_have_text('Settings')
    expect(phone.locator('#editor-type')).to_have_value('moment')  # that section's kind and heading, filled in
    expect(phone.locator('#editor-group')).to_have_value('Moments')
    phone.page.click('#editor-cancel')
    expect(phone.locator('h1')).to_have_text('Today')  # a mistap costs one tap
    expect(phone.locator('#arrange-done')).to_be_visible()  # still arranging

    add_moment.click()
    phone.page.fill('#editor-name', 'Snack')
    phone.page.click('#editor-save')
    expect(phone.locator('h1')).to_have_text('Today')
    expect(phone.locator('[data-arrange]', has_text='Snack')).to_have_count(1)  # there to be put in its place

    # Added under Symptoms and made a one-tap moment: it stays under Symptoms, where it was added.
    phone.locator('[aria-label="Add to Symptoms"]').click()
    phone.page.fill('#editor-name', 'Dizzy spell')
    phone.page.select_option('#editor-type', 'moment')
    phone.page.click('#editor-save')
    phone.page.click('#arrange-done')
    symptoms = phone.locator('#view-today > section', has=phone.locator('h2', has_text='Symptoms'))
    expect(symptoms.locator('.moment-button', has_text='Dizzy spell')).to_have_count(1)
    expect(phone.locator('.moment-button', has_text='Snack')).to_have_count(1)

    phone.go_to('Check in')
    phone.locator('.add-link', has_text='Add').first.click()
    expect(phone.locator('#editor-type')).to_have_value('rating')
    phone.page.click('#editor-cancel')
    expect(phone.locator('h1')).to_have_text('Check in')
