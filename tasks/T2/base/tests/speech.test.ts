// 实时合成前把题目写法换成读法（speakable），以及预合成配音的命名与转写核对（clipKey、clipMatches）
import test from "node:test";
import assert from "node:assert/strict";
import { CLIP_VOICE, clipKey, clipMatches, clipPath, clipRejectedPath, SPEAKER, speakable } from "../src/live/speech.ts";

const clipA = await clipKey("One half is three sixths."), clipB = await clipKey("One half is three sixths!");
test("预合成配音：按「声音版本＋文字」命名；转写核对拦下漏读", () => {
  assert.match(clipA, /^[0-9a-f]{32}$/);
  assert.notEqual(clipA, clipB, "文字差一个字就是另一段");
  assert.ok(CLIP_VOICE.includes(SPEAKER) && CLIP_VOICE.includes("seed-tts-2.0"), "音色、模型变了名字全变");
  assert.equal(clipPath(clipA), `lesson/${clipA}.mp3`);
  assert.notEqual(clipRejectedPath(clipA), clipPath(clipA), "核对没过的记号与配音分开放");
  assert.ok(clipMatches("One half is three sixths, and 12 is the lowest common multiple.", "One-half is three sixths, and twelve is the lowest common multiple.").ok, "数字读法、连字符不算错");
  assert.ok(!clipMatches("Three quarters is nine twelfths, and one third is four twelfths.", "Three quarters is nine.").ok, "漏读要拦下，不存进桶");
  assert.ok(!clipMatches("Your turn! How many balloons are there?", "Your turn! How many are there?").ok, "短句漏一个词也拦下");
  assert.ok(clipMatches("Ravi and Mei Ling gave Wei Jie 3 each.", "Ravi and Meiling gave Wei-Ji three each.").ok, "人名拼法的出入不算读错");
  assert.equal(clipMatches("The farm has 3,600 chickens, and 41 is 4 tens and 1 one. So 1/4 + 1/6 = 5/12.", "The farm has three thousand six hundred chickens, and forty-one is four tens and one one. So one quarter plus one sixth equals five twelfths.").errors, 0, "多位数、千分位、分数与算式的读法都对得上");
  assert.ok(clipMatches("Then 1% is $250 divided by 100, which is $2.50, so the tax is $22.50.", "Then one percent is two hundred fifty dollars divided by one hundred, which is two dollars and fifty cents, so the tax is twenty-two dollars and fifty cents.").errors <= 1, "带分的钱数");
  assert.equal(clipMatches("The left rectangle is 5 centimetres wide: 40 square centimetres, and 250 millilitres.", "The left rectangle is 5 cm wide. 40 square centimetres, and two hundred fifty mL.").errors, 0, "单位全称与缩写");
  assert.ok(!clipMatches("The perimeter is 12 centimetres.", "The perimeter is 12 metres.").ok, "单位读错仍拦下");
});
test("实时合成的读法：Siti says 23 ÷ 4 = 4 R 7. Is she right?", () => {
  assert.equal(speakable("Siti says 23 ÷ 4 = 4 R 7. Is she right?"), "Siti says 23 ÷ 4 = 4 remainder 7. Is she right?", "余数 R");
});
test("实时合成的读法：Which fact fits into 46: 6 × 7 or 6 × 8?", () => {
  assert.equal(speakable("Which fact fits into 46: 6 × 7 or 6 × 8?"), "Which fact fits into 46? 6 times 7 or 6 times 8?", "× 读 times；冒号接数断开");
});
test("实时合成的读法：Question 3: 5 + 3 = ?", () => {
  assert.equal(speakable("Question 3: 5 + 3 = ?"), "Question 3. 5 + 3 = what", "题号后接算式断成两句，空格读 what");
});
test("实时合成的读法：In a finished 4 × 4 Sudoku, how many 3s are in each row?", () => {
  assert.equal(speakable("In a finished 4 × 4 Sudoku, how many 3s are in each row?"), "In a finished 4 by 4 Sudoku, how many 3s are in each row?", "尺寸读 by");
});
test("实时合成的读法：To answer 4 : 6 = ? : 9, Bruno says 2 : 3.", () => {
  assert.equal(speakable("To answer 4 : 6 = ? : 9, Bruno says 2 : 3."), "To answer 4 to 6 = what to 9, Bruno says 2 to 3.", "比与比里的空格");
});
test("实时合成的读法：What digit can go in the box so that 3.?2 is greater than 3.91?", () => {
  assert.equal(speakable("What digit can go in the box so that 3.?2 is greater than 3.91?"), "What digit can go in the box so that 3 point box 2 is greater than 3.91?", "小数里的方框");
});
test("实时合成的读法：Which sign goes in the box, > or <? Bruno wrote 2 > 4.", () => {
  assert.equal(speakable("Which sign goes in the box, > or <? Bruno wrote 2 > 4."), "Which sign goes in the box, greater than or less than? Bruno wrote 2 is greater than 4.");
});
test("实时合成的读法：What does the sign ≈ mean?", () => {
  assert.equal(speakable("What does the sign ≈ mean?"), "What does the sign mean?", "问符号的意思时不念出意思");
});
test("实时合成的读法：Ravi says 1 h 30 min is 130 minutes. Siti swam it in 55 s at 3 m/s, then 80 km/h.", () => {
  assert.equal(speakable("Ravi says 1 h 30 min is 130 minutes. Siti swam it in 55 s at 3 m/s, then 80 km/h."), "Ravi says 1 hour 30 minutes is 130 minutes. Siti swam it in 55 seconds at 3 metres per second, then 80 kilometres per hour.");
});
test("实时合成的读法：Question 1: Is it 6.15 or 3.30? Ali says this clock shows 12.52.", () => {
  assert.equal(speakable("Question 1: Is it 6.15 or 3.30? Ali says this clock shows 12.52.", true), "Question 1: Is it 6:15 or 3:30? Ali says this clock shows 12:52.", "板上有钟：裸写的钟点按钟点念");
});
test("实时合成的读法：Is it 6.15 or 3.30?", () => {
  assert.equal(speakable("Is it 6.15 or 3.30?"), "Is it 6.15 or 3.30?", "没有钟就是小数");
});
test("实时合成的读法：钱、分数、度、面积体积等本来念得对的写法不动", () => {
  const fine = "Ravi had $50. A pen costs $1.20, 1/4 + 1 1/2 = 7/4, 10% off, 30°, 9 cm², 125 cm³, 30¢, 5,382, 7.15 a.m., 50 + 8h dollars for h hours.";
  assert.equal(speakable(fine), fine, "钱、分数、带分数、百分数、度、面积体积、分、千分位、a.m.、代数本来就念得对");
});
test("实时合成的读法：It costs $3.30.", () => {
  assert.equal(speakable("It costs $3.30.", true), "It costs $3.30.", "有钟时钱也不动");
});
test("实时合成的读法：What is √49 + ∛64?", () => {
  assert.equal(speakable("What is √49 + ∛64?"), "What is the square root of 49 + the cube root of 64?", "平方根、立方根");
});
test("实时合成的读法：Which is true: x ≥ 4, y ≤ 9 or 3 ≠ 3?", () => {
  assert.equal(speakable("Which is true: x ≥ 4, y ≤ 9 or 3 ≠ 3?"), "Which is true: x is greater than or equal to 4, y is less than or equal to 9 or 3 is not equal to 3?", "≥ ≤ ≠ 在两个数或字母之间读 is …");
});
test("实时合成的读法：Which sign goes in the box, ≥ or ≤?", () => {
  assert.equal(speakable("Which sign goes in the box, ≥ or ≤?"), "Which sign goes in the box, greater than or equal to or less than or equal to?", "单独列出符号时不带 is");
});
test("实时合成的读法：What does the sign ≠ mean?", () => {
  assert.equal(speakable("What does the sign ≠ mean?"), "What does the sign mean?", "问符号的意思时不念出意思");
});
