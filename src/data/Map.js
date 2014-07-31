define(['Util', 'data/Associative'], function (Util, Associative) {

  /* ------------------ */
  /* Map configuration. */
  /* ------------------ */

  var SECTION_SIZE = 5;
  var BUCKET_SIZE = Math.pow(2, SECTION_SIZE); // 32
  var MASK = BUCKET_SIZE - 1;                  // 31

  /* ----------- */
  /* Hash utils. */
  /* ----------- */

  var hashFragment, popCount, toBitmap, fromBitmap;

  hashFragment = function (shift, hash) {
    return (hash >>> shift) & MASK;
  };

  popCount = function (x) {
    var m1 = 0x55555555, m2 = 0x33333333, m4 = 0x0f0f0f0f;
    x = x - ((x >> 1) & m1);
    x = (x & m2) + ((x >> 2) & m2);
    x = (x + (x >> 4)) & m4;
    x = x + (x >> 8);
    x = x + (x >> 16);
    return x & 0x7f;
  };

  toBitmap = function (fragment) {
    return 1 << fragment;
  };

  fromBitmap = function (bitmap, bit) {
    return popCount(bitmap & (bit - 1));
  };

  /* ---------------- */
  /* Private helpers. */
  /* ---------------- */

  var EMPTY_NODE, NOTHING, isEmpty, isNothing, updateEmpty, update, reduce, find, equals, isInstance;

  EMPTY_NODE = null;
  NOTHING = {};

  isEmpty = function (node) {
    return !node;
  };

  isNothing = function (x) {
    return x === NOTHING;
  };

  updateEmpty = function (hash, key, f) {
    var value = f();
    return isNothing(value) ? EMPTY_NODE : new LeafNode(hash, key, value);
  };

  update = function (shift, hash, key, f, node) {
    return isEmpty(node) ? updateEmpty(hash, key, f) : node.update(shift, hash, key, f);
  };

  reduce = function (f, acc, node) {
    return isEmpty(node) ? acc : node.reduce(f, acc);
  };

  find = function (pred, node) {
    var result = null;
    for (var i = 0; i < node._children.length; i++) {
      var found = node._children[i].find(pred);
      if (found) {
        result = found;
        break;
      }
    }
    return result;
  };

  equals = function (node1, node2, self) {
    if (node1 === node2) {
      return true;
    } else {
      var node1Empty = isEmpty(node1);
      var node2Empty = isEmpty(node2);

      if (node1Empty || node2Empty) {
        return node1Empty && node2Empty;
      } else {
        return node1.equals(node2, self);
      }
    }
  };

  isInstance = function (obj) {
    return obj instanceof Map;
  };

  var mergeLeaves = function (shift, node1, node2) {
    var hash1 = node1._hash, hash2 = node2._hash;
    if (hash1 === hash2) {
      return new CollisionNode(hash1, [node1, node2]);
    } else {
      var hash1Fragment = hashFragment(shift, hash1);
      var hash2Fragment = hashFragment(shift, hash2);

      return new IndexedNode(
          toBitmap(hash1Fragment) | toBitmap(hash2Fragment),
          hash1Fragment === hash2Fragment ?
            [mergeLeaves(shift + SECTION_SIZE, node1, node2)] :
            (hash1Fragment < hash2Fragment) ? [node1, node2] : [node2, node1]
      );
    }
  };

  var mergeReduceFunction = function (acc, value, key) {
    var dest = acc.get(key);
    var mergedValue = (dest && isInstance(dest) && isInstance(value)) ? dest.merge(value) : value;
    return acc.assoc(key, mergedValue);
  };

  /* --------------- */
  /* Internal nodes. */
  /* --------------- */

  var LeafNode, CollisionNode, IndexedNode;

  LeafNode = function (hash, key, value) {
    /** Full hash of the key. */
    this._hash = hash;
    /** Leaf key. */
    this._key = key;
    /** Node value. */
    this._value = value;
  };

  LeafNode.prototype = Object.freeze({

    get: function (_shift, _hash, key) {
      return key === this._key ? this._value : null;
    },

    update: function (shift, hash, key, f) {
      var value;
      if (key === this._key) {
        value = f(this._value);
        return isNothing(value) ?
          EMPTY_NODE :
          (value !== this._value ? new LeafNode(hash, key, value) : this);
      } else {
        value = f();
        if (isNothing(value)) {
          return this;
        } else {
          return mergeLeaves(shift, this, new LeafNode(hash, key, value));
        }
      }
    },

    reduce: function (f, acc) {
      return f(acc, this);
    },

    map: function (f) {
      var value = f(this._value);
      return value === this._value ? this : new LeafNode(this._hash, this._key, f(this._value, this._key));
    },

    find: function (pred) {
      return pred(this._value, this._key) ? this._value : null;
    },

    equals: function (leaf, self) {
      if (leaf instanceof LeafNode && this._key === leaf._key) {
        return self.isAssociative(this._value) && self.isAssociative(leaf._value) ?
          this._value.equals(leaf._value) :
          this._value === leaf._value;
      } else {
        return false;
      }
    }

  });

  CollisionNode = function (hash, children) {
    /** Full hash of the key. */
    this._hash = hash;
    /** Array of leaves with same hash but different keys. */
    this._children = children;
  };

  CollisionNode.prototype = (function () {
    var updateCollisions = function (collisions, hash, key, f) {
      var existing = Util.findWithIndex(collisions, function (leaf) { return leaf._key === key; });
      var value, newCollisions;

      if (existing) {
        var index = existing.index;
        value = f(existing.value);

        if (value !== existing.value) {
          newCollisions = collisions.slice(0);
          if (isNothing(value)) {
            newCollisions.splice(index, 1);
          } else {
            newCollisions[index] = new LeafNode(hash, key, value);
          }
        } else {
          newCollisions = collisions;
        }
      } else {
        value = f();
        if (!isNothing(value)) {
          newCollisions = collisions.slice(0);
          newCollisions.push(new LeafNode(hash, key, value));
        } else {
          newCollisions = collisions;
        }
      }

      return newCollisions;
    };

    return Object.freeze({

      get: function (_shift, _hash, key) {
        var node = Util.find(this._children, function (node) {
          return node._key === key;
        });
        return node ? node._value : null;
      },

      update: function (shift, hash, key, f) {
        if (hash === this._hash) {
          var list = updateCollisions(this._children, hash, key, f);
          return list.length > 1 ? new CollisionNode(this._hash, list) : list[0];
        } else {
          var value = f();
          return isNothing(value) ? this : mergeLeaves(shift, this, new LeafNode(hash, key, value));
        }
      },

      reduce: function (f, acc) {
        return this._children.reduce(f, acc);
      },

      map: function (f) {
        return new CollisionNode(this._hash, this._children.map(function (child) {
          return child.map(f);
        }));
      },

      find: function (pred) {
        var child = Util.find(this._children, function (child) {
          return pred(child._value, child._key);
        });
        return child ? child._value : null;
      },

      equals: function (node, self) {
        return node instanceof CollisionNode &&
          this._hash === node._hash &&
          this._children.length === node._children.length &&
          this._children.every(function (child, index) {
            return child.equals(node._children[index], self);
          });
      }

    });
  })();

  IndexedNode = function (mask, children) {
    /** Bitmap mask. */
    this._mask = mask;
    /** Array of children. */
    this._children = children;
  };

  IndexedNode.prototype = Object.freeze({

    get: function (shift, hash, key) {
      var fragment = hashFragment(shift, hash);
      var bit = toBitmap(fragment);
      var exists = this._mask & bit;

      return exists ?
        this._children[fromBitmap(this._mask, bit)].get(shift + SECTION_SIZE, hash, key) :
        null;
    },

    update: function (shift, hash, key, f) {
      var fragment = hashFragment(shift, hash);
      var bit = toBitmap(fragment);
      var index = fromBitmap(this._mask, bit);
      var exists = this._mask & bit;

      var children = this._children;

      var child = exists ?
        children[index].update(shift + SECTION_SIZE, hash, key, f) :
        updateEmpty(hash, key, f);

      var removed = exists && isEmpty(child);
      var added = !exists && !isEmpty(child);

      var newMask = removed ? this._mask & ~bit : (added ? this._mask | bit : this._mask);

      if (!newMask) {
        return EMPTY_NODE;
      } else {
        var originalLength = children.length;
        var newLength = removed ? originalLength - 1 : (added ? originalLength + 1 : originalLength);
        if (removed) {
          if (newLength === 1 && children[index ^ 1] instanceof LeafNode) {
            return children[index ^ 1];
          } else {
            return new IndexedNode(newMask, Util.arrayRemove(children, index));
          }
        } else if (added) {
          return new IndexedNode(newMask, Util.arrayInsert(children, index, child));
        } else {
          return new IndexedNode(newMask, Util.arrayUpdate(children, index, child));
        }
      }
    },

    reduce: function (f, acc) {
      var children = this._children;
      var acc2 = acc;
      for (var i = 0, len = children.length; i < len; i++) {
        var child = children[i];
        acc2 = child instanceof LeafNode ? f(acc2, child) : child.reduce(f, acc2);
      }
      return acc2;
    },

    map: function (f) {
      return new IndexedNode(this._mask, this._children.map(function (child) {
        return child.map(f);
      }));
    },

    find: function (pred) {
      return find(pred, this);
    },

    equals: function (node, self) {
      return node instanceof IndexedNode &&
        this._children.length === node._children.length &&
        this._children.every(function (child, index) {
          var otherChild = node._children[index];
          return otherChild && child.equals(otherChild, self);
        });
    }

  });

  /* ----------------- */
  /* Map wrapper type. */
  /* ----------------- */

  /** Map constructor.
   * @param {Object} root root node
   * @public
   * @class Map
   * @augments Associative
   * @classdesc HAMT-based persistent map implementation with String keys.
   * Uses Java-style hashcode implementation.
   * <p>Map methods try to return original instance if they don't 'change' it,
   * e.g. on filter if no elements are filtered, on update if no value is changed,
   * on join with empty map, and so on. */
  var Map = function (root) {
    /** @private */
    this._root = root;
  };

  Map.prototype = Object.freeze( /** @lends Map.prototype */ {

    // common methods

    /** Fill map from variable-length arguments list.
     * If key is already present, its value is replaced.
     * @param {...Object} var_args arguments list in form of 'key1, value1, key2, value2, ...' key-value pairs
     * @return {Map} new map instance, original is unaffected */
    fill: function (var_args) {
      var m = this;
      for (var i = 0; i < arguments.length; i += 2) {
        m = m.assoc(arguments[i], arguments[i + 1]);
      }
      return m;
    },

    /** Check whether map is empty.
     * @return {Boolean} */
    isEmpty: function () {
      return isEmpty(this._root);
    },

    /** Get value by key.
     * @param {String} key key
     * @return {Object} value or null */
    get: function (key) {
      if (this.isEmpty()) {
        return null;
      } else {
        var result = this._root.get(0, Util.hashcode(key), key);
        return Util.undefinedOrNull(result) ? null : result;
      }
    },

    /** Check if map contains a mapping for the specified key.
     * @param {String} key key
     * @return {Boolean} */
    contains: function (key) {
      return this.get(key) !== null;
    },

    /** Update existing value or create new mapping.
     * If key is missing, f will be called without arguments and the result will be associated with the key.
     * @param {String} key key
     * @param {Function} f update function
     * @return {Map} new map instance, original is unaffected */
    update: function (key, f) {
      var newRoot = update(0, Util.hashcode(key), key, f, this._root);
      return newRoot === this._root ? this : new Map(newRoot);
    },

    /** Update existing value.
     * @param {String} key key
     * @param {Function} f update function
     * @return {Map} new map instance, original is unaffected */
    updateIfExists: function (key, f) {
      return this.contains(key) ? this.update(key, f) : this;
    },

    /** Associate a key with a value.
     * @param {String} key key
     * @param {*} value value
     * @return {Map} new map instance, original is unaffected */
    assoc: function (key, value) {
      return this.update(key, Util.constantly(value));
    },

    /** Remove a mapping.
     * @param {String} key key
     * @return {Map} new map instance, original is unaffected */
    dissoc: function (key) {
      return this.update(key, Util.constantly(NOTHING));
    },

    /** Join two maps. If key is already present in this map, its value is replaced.
     * @param {Map} otherMap map to join with
     * @return {Map} new map instance, original maps are unaffected */
    join: function (otherMap) {
      return this.isEmpty() ?
        otherMap :
        otherMap.reduce(function (acc, value, key) { return acc.assoc(key, value); }, this);
    },

    /** Create map iterator.
     * @see Iter
     * @see MapIter
     * @returns {MapIter} */
    iter: function () {
      return new MapIter(this);
    },

    /** Reduce map values with function f and initial value acc.
     * @param {Function} f function of (acc, value, key, originalMap); should return next accumulator value
     * @param {*} acc initial value
     * @return {*} reduce result */
    reduce: function (f, acc) {
      var self = this;
      return reduce(
        function (acc, node) { return f(acc, node._value, node._key, self); },
        acc,
        this._root
      );
    },

    /** Map values.
     * @param {Function} f map function
     * @return {Map} new map instance, original is unaffected */
    map: function (f) {
      return this.isEmpty() ? this : new Map(this._root.map(function (value, key) {
        return f(value, key, this);
      }.bind(this)));
    },

    /** Execute side-effecting function for each entry.
     * @param {Function} f function called for each entry */
    foreach: function (f) {
      reduce(
        function (_acc, node) { f(node._value, node._key, this); }.bind(this),
        null,
        this._root
      );
    },

    /** Filter using a predicate.
     * @param {Function} pred predicate
     * @return {Map} new map instance, original is unaffected */
    filter: function (pred) {
      var self = this;
      var result = this.reduce(
        function (acc, value, key) {
          if (pred(value, key, self)) {
            acc.map = acc.map.assoc(key, value);
          } else {
            acc.someSkipped = true;
          }
          return acc;
        },
        { map: EMPTY_MAP, someSkipped: false }
      );
      return result.someSkipped ? result.map : self;
    },

    /** Find value using a predicate.
     * @param {Function} pred predicate
     * @returns {*} found value or null */
    find: function (pred) {
      return this.isEmpty() ? null : this._root.find(function (value, key) {
        return pred(value, key, this);
      }.bind(this));
    },

    /** Check whether both maps contain exactly the same keys mapped to the same values.
     * Associative values are compared recursively, ordinal values are compared using '==='.
     * @param {Map} otherMap map to compare with
     * @return {Boolean} */
    equals: function (otherMap) {
      return this === otherMap || (otherMap instanceof Map && equals(this._root, otherMap._root, this));
    },

    /** Get the number of mappings.
     * @return {Number} */
    size: function () {
      return reduce(function (acc) { return acc + 1; }, 0, this._root);
    },

    /** Get human-readable map representation.
     * @return {String} */
    toString: function () {
      var result = this.reduce(
        function (acc, value, key) {
          var s = acc === '' ? '' : acc + ', ';
          s += '"' + key + '": ' + Util.toString(value);
          return s;
        },
        ''
      );
      return '{' + result + '}';
    },

    /** Check whether obj is map instance.
     * @param {*} obj object to check
     * @return {Boolean} */
    isInstance: function (obj) {
      return isInstance(obj);
    },

    // Map-specific methods

    /** Get all mappings as an array of [key, value] arrays.
     * @return {Array} array of [key, value] arrays */
    entries: function () {
      return reduce(function (acc, node) { acc.push([node._key, node._value]); return acc; }, [], this._root);
    },

    /** Get all keys as an array.
     * @return {Array} array of keys */
    keys: function () {
      return reduce(function (acc, node) { acc.push(node._key); return acc; }, [], this._root);
    },

    /** Get all values as an array.
     * @return {Array} array of values */
    values: function () {
      return reduce(function (acc, node) { acc.push(node._value); return acc; }, [], this._root);
    },

    /** Fill map from JavaScript object.
     * If key is already present, its value is replaced.
     * @param {Object} obj JavaScript object
     * @param {Function} [f] function applied to each value
     * @return {Map} new map instance, original is unaffected */
    fillFromObject: function (obj, f) {
      var effectiveF = f || Util.identity;
      return Object.keys(obj).reduce(function (map, key) { return map.assoc(key, effectiveF(obj[key])); }, this);
    },

    /** Convert to JavaScript object.
     * @param {Function} [f] function applied to each value
     * @return {Object} JavaScript object containing same mappings as this map */
    toObject: function (f) {
      var effectiveF = f || Util.identity;
      return this.reduce(function (obj, value, key) { obj[key] = effectiveF(value); return obj; }, {});
    },

    /** Deep merge another map into this.
     * Another map has higher priority in case of non-mergeable conflicting values.
     * @param {Map} otherMap map to merge data from
     * @return {Map} new map instance, original is unaffected */
    merge: function (otherMap) {
      return this.isEmpty() || this === otherMap ? otherMap : otherMap.reduce(mergeReduceFunction, this);
    },

    /** Ensure safe key.
     * @param {String} key key
     * @returns {String} key without special symbol, e.g. dot */
    makeSafeKey: function (key) {
      return key.replace(/\./g, '');
    }

  });

  Util.subclass(Map, Associative);

  /** Map iterator constructor.
   * @param {Map} map map
   * @public
   * @class MapIter
   * @augments Iter
   * @classdesc Map iterator. */
  var MapIter = function (map) {
    /** @private */
    this._map = map;
    /** @private */
    this._nextKeys = map.keys();
  };

  MapIter.prototype = Object.freeze( /** @lends MapIter.prototype */ {

    /** Check if iterator has more elements.
     * @return {Boolean} */
    hasNext: function () {
      return this._nextKeys.length > 0;
    },

    /** Get next pair and advance iterator one step forward. Returns object having 'key' and 'value' properties.
     * @return {{key: String, value: *}} */
    next: function () {
      var key = this._nextKeys[0];
      var value = this._map.get(key);
      this._nextKeys.splice(0, 1);
      return { key: key, value: value };
    }

  });

  Util.subclass(MapIter, Map._super.Iter);

  var EMPTY_MAP = new Map(EMPTY_NODE);

  return EMPTY_MAP;

});